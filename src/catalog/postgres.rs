//! PostgreSQL is the authoritative catalog read path for the gateway.

mod write;

use std::collections::HashMap;

use anyhow::{Context, Result, ensure};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{Map, Value};
use sqlx::{FromRow, PgPool, Postgres, Transaction};

use super::secrets::CatalogSecrets;
use super::{CatalogProvider, RuntimeCatalog, validation};
use crate::models::{
    CallModelConfig, ModelConfig, ProjectConfig, ProviderConfig, RouteCandidatesFilter,
    RouteEndpoint, RouteMatchConfig, RouteRuleConfig,
};
use crate::script_engine::ScriptEngine;

/// PostgreSQL-backed gateway snapshot loader and catalog writer.
#[derive(Debug, Clone)]
pub struct PgCatalogProvider {
    /// Database connection pool.
    pool: PgPool,
    /// Instance-wide catalog key material.
    secrets: CatalogSecrets,
    /// Script compiler for validating stored snapshots.
    engine: ScriptEngine,
}

/// Catalog state as reported to the operator (never includes digests).
#[derive(Debug, FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CatalogStatus {
    /// Current database revision; zero means no snapshot has been imported.
    pub(crate) revision: i64,
    /// Which writer, if any, may update the directory.
    write_mode: String,
    /// Last successful replacement.
    updated_at: Option<DateTime<Utc>>,
    /// Last failed JSON check, if any.
    sync_error: Option<String>,
}

impl PgCatalogProvider {
    /// Creates a catalog store using the same pool as telemetry.
    #[must_use]
    pub const fn new(pool: PgPool, secrets: CatalogSecrets, engine: ScriptEngine) -> Self {
        Self {
            pool,
            secrets,
            engine,
        }
    }

    /// Turns off JSON writes for this database. PostgreSQL readers continue unchanged.
    ///
    /// # Errors
    /// Returns an error if there is no verified snapshot or the database cannot be updated.
    pub async fn disable_json_sync(&self) -> Result<()> {
        let revision = self.load_catalog().await?.revision();
        let result = sqlx::query(
            "UPDATE catalog_state SET write_mode = 'postgres', sync_error = NULL \
             WHERE singleton AND revision = $1 AND key_tag = $2",
        )
        .bind(revision)
        .bind(self.secrets.key_tag().as_slice())
        .execute(&self.pool)
        .await?;
        ensure!(
            result.rows_affected() == 1,
            "catalog changed; retry disabling JSON sync"
        );
        Ok(())
    }

    /// Returns whether the database still accepts the legacy JSON writer.
    pub(super) async fn accepts_json(&self) -> Result<bool, sqlx::Error> {
        sqlx::query_scalar("SELECT write_mode = 'json_sync' FROM catalog_state WHERE singleton")
            .fetch_one(&self.pool)
            .await
    }

    /// Returns the committed revision without loading or compiling configuration.
    pub(super) async fn revision(&self) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar("SELECT revision FROM catalog_state WHERE singleton")
            .fetch_one(&self.pool)
            .await
    }

    /// Records a sanitized import failure without moving the revision.
    pub(super) async fn mark_sync_failed(&self) -> Result<()> {
        sqlx::query(
            "UPDATE catalog_state SET sync_error = 'JSON 同步失败' \
             WHERE singleton AND write_mode = 'json_sync' AND sync_error IS NULL",
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Reads one committed snapshot without mixing rows from different versions.
    async fn read_snapshot(&self) -> Result<RuntimeCatalog> {
        let mut tx = begin_read(&self.pool).await?;
        let (revision, key_tag) = sqlx::query_as::<_, (i64, Option<Vec<u8>>)>(
            "SELECT revision, key_tag FROM catalog_state WHERE singleton",
        )
        .fetch_one(&mut *tx)
        .await?;
        ensure!(revision > 0, "no PostgreSQL catalog has been imported");
        ensure!(
            key_tag.as_deref() == Some(self.secrets.key_tag().as_slice()),
            "LINGUIST_CATALOG_KEY does not match the PostgreSQL catalog"
        );

        let providers = self.read_providers(&mut tx).await?;
        let (projects, digests) = read_projects(&mut tx).await?;
        let routes = read_routes(&mut tx).await?;
        tx.commit().await?;
        Ok(
            RuntimeCatalog::new(providers, projects, routes).with_project_auth(
                revision,
                self.secrets.clone(),
                digests,
            ),
        )
    }

    /// Loads supply-side rows in their original candidate order.
    async fn read_providers(
        &self,
        tx: &mut Transaction<'_, Postgres>,
    ) -> Result<Vec<ProviderConfig>> {
        let mut by_provider: HashMap<String, Vec<ModelConfig>> = HashMap::new();
        for row in sqlx::query_as::<_, ModelRow>(
            "SELECT provider_id,id,name,icon,url,supports_reasoning_effort,tool_calling,vision,\
             thinking,streaming,max_input_tokens,max_output_tokens,script \
             FROM catalog_provider_models ORDER BY provider_id,position",
        )
        .fetch_all(&mut **tx)
        .await?
        {
            let ModelRow {
                provider_id,
                id,
                name,
                icon,
                url,
                supports_reasoning_effort,
                tool_calling,
                vision,
                thinking,
                streaming,
                max_input_tokens,
                max_output_tokens,
                script,
            } = row;
            by_provider
                .entry(provider_id)
                .or_default()
                .push(ModelConfig {
                    id,
                    name,
                    icon,
                    url,
                    supports_reasoning_effort,
                    tool_calling,
                    vision,
                    thinking,
                    streaming,
                    script,
                    max_input_tokens: max_input_tokens.map(u64::try_from).transpose()?,
                    max_output_tokens: max_output_tokens.map(u64::try_from).transpose()?,
                });
        }
        sqlx::query_as::<_, ProviderRow>(
            "SELECT id,name,icon,vendor,api_type,encrypted_key,script FROM catalog_providers ORDER BY position",
        ).fetch_all(&mut **tx).await?.into_iter().map(|row| {
            let api_key = self.secrets.open_provider(&row.id, row.encrypted_key)?;
            let models = by_provider.remove(&row.id).unwrap_or_default();
            Ok(ProviderConfig {
                id: row.id, name: row.name, icon: row.icon, vendor: row.vendor, api_type: row.api_type,
                script: row.script, api_key, models,
            })
        }).collect()
    }
}

#[async_trait]
impl CatalogProvider for PgCatalogProvider {
    async fn load_catalog(&self) -> Result<RuntimeCatalog> {
        let catalog = self.read_snapshot().await?;
        let engine = self.engine.clone();
        tokio::task::spawn_blocking(move || {
            validation::validate(&catalog)?;
            validation::validate_scripts(&catalog, &engine)?;
            Ok(catalog)
        })
        .await
        .context("PostgreSQL catalog validation task failed")?
    }
}

/// Uses a consistent view for both API and gateway reads during replacement.
pub(crate) async fn begin_read(pool: &PgPool) -> Result<Transaction<'_, Postgres>, sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    Ok(tx)
}

/// Fetches the database-visible status without secret data.
pub(crate) async fn catalog_status(pool: &PgPool) -> Result<CatalogStatus, sqlx::Error> {
    sqlx::query_as(
        "SELECT revision,write_mode,updated_at,sync_error FROM catalog_state WHERE singleton",
    )
    .fetch_one(pool)
    .await
}

/// Loads consumer-side rows with their model order and keyed credential digests.
async fn read_projects(
    tx: &mut Transaction<'_, Postgres>,
) -> Result<(Vec<ProjectConfig>, HashMap<String, Vec<u8>>)> {
    let mut by_project: HashMap<String, Vec<CallModelConfig>> = HashMap::new();
    for row in sqlx::query_as::<_, ProjectModelRow>(
        "SELECT project_id,id,name,icon,meta,script FROM catalog_project_models \
         ORDER BY project_id,position",
    )
    .fetch_all(&mut **tx)
    .await?
    {
        by_project
            .entry(row.project_id)
            .or_default()
            .push(CallModelConfig {
                id: row.id,
                name: row.name,
                icon: row.icon,
                meta: row.meta.0,
                script: row.script,
            });
    }
    let rows = sqlx::query_as::<_, ProjectRow>(
        "SELECT id,name,icon,key_digest,meta,script FROM catalog_projects ORDER BY position",
    )
    .fetch_all(&mut **tx)
    .await?;
    let mut digests = HashMap::with_capacity(rows.len());
    let projects = rows
        .into_iter()
        .map(|row| {
            digests.insert(row.id.clone(), row.key_digest);
            let call_models = by_project.remove(&row.id).unwrap_or_default();
            ProjectConfig {
                id: row.id,
                name: row.name,
                icon: row.icon,
                api_key: None,
                meta: row.meta.0,
                script: row.script,
                call_models,
            }
        })
        .collect();
    Ok((projects, digests))
}

/// Loads routing rules and preserves ties and fallback positions.
async fn read_routes(tx: &mut Transaction<'_, Postgres>) -> Result<Vec<RouteRuleConfig>> {
    let mut by_route: HashMap<String, (Option<RouteEndpoint>, Vec<RouteEndpoint>)> = HashMap::new();
    for row in sqlx::query_as::<_, TargetRow>(
        "SELECT route_id,position,provider_id,model_id,max_attempts FROM catalog_route_targets \
         ORDER BY route_id,position",
    )
    .fetch_all(&mut **tx)
    .await?
    {
        let targets = by_route.entry(row.route_id).or_default();
        let endpoint = RouteEndpoint {
            provider_id: row.provider_id,
            model_id: row.model_id,
            max_attempts: u8::try_from(row.max_attempts)?,
        };
        if row.position == 0 {
            targets.0 = Some(endpoint);
        } else {
            targets.1.push(endpoint);
        }
    }
    Ok(sqlx::query_as::<_, RuleRow>(
        "SELECT id,name,enabled,priority,project_ids,call_model_ids,allow_patterns,deny_patterns,\
         rewrite_response_model,script FROM catalog_route_rules ORDER BY priority DESC,position",
    )
    .fetch_all(&mut **tx)
    .await?
    .into_iter()
    .map(|row| {
        let (target, fallbacks) = by_route.remove(&row.id).unwrap_or_default();
        RouteRuleConfig {
            id: row.id,
            name: row.name,
            enabled: row.enabled,
            priority: row.priority,
            match_rule: RouteMatchConfig {
                project_ids: row.project_ids,
                call_model_ids: row.call_model_ids,
            },
            candidates: RouteCandidatesFilter {
                allow: row.allow_patterns,
                deny: row.deny_patterns,
            },
            target,
            fallbacks,
            rewrite_response_model: row.rewrite_response_model,
            script: row.script,
        }
    })
    .collect())
}

/// Typed SQL row projections for internal runtime loading (never serialized to the UI).
#[allow(clippy::missing_docs_in_private_items)]
mod rows {
    use super::{FromRow, Map, Value};
    use sqlx::types::Json;

    #[derive(FromRow)]
    pub(super) struct ProviderRow {
        pub(super) id: String,
        pub(super) name: String,
        pub(super) icon: String,
        pub(super) vendor: Option<String>,
        pub(super) api_type: Option<String>,
        pub(super) encrypted_key: Option<Vec<u8>>,
        pub(super) script: Option<String>,
    }

    #[derive(FromRow)]
    pub(super) struct ModelRow {
        pub(super) provider_id: String,
        pub(super) id: String,
        pub(super) name: String,
        pub(super) icon: String,
        pub(super) url: String,
        pub(super) supports_reasoning_effort: Option<Vec<String>>,
        pub(super) tool_calling: Option<bool>,
        pub(super) vision: Option<bool>,
        pub(super) thinking: Option<bool>,
        pub(super) streaming: Option<bool>,
        pub(super) max_input_tokens: Option<i64>,
        pub(super) max_output_tokens: Option<i64>,
        pub(super) script: Option<String>,
    }

    #[derive(FromRow)]
    pub(super) struct ProjectRow {
        pub(super) id: String,
        pub(super) name: String,
        pub(super) icon: String,
        pub(super) key_digest: Vec<u8>,
        pub(super) meta: Json<Map<String, Value>>,
        pub(super) script: Option<String>,
    }

    #[derive(FromRow)]
    pub(super) struct ProjectModelRow {
        pub(super) project_id: String,
        pub(super) id: String,
        pub(super) name: String,
        pub(super) icon: String,
        pub(super) meta: Json<Map<String, Value>>,
        pub(super) script: Option<String>,
    }

    #[derive(FromRow)]
    pub(super) struct RuleRow {
        pub(super) id: String,
        pub(super) name: String,
        pub(super) enabled: bool,
        pub(super) priority: i32,
        pub(super) project_ids: Vec<String>,
        pub(super) call_model_ids: Vec<String>,
        pub(super) allow_patterns: Vec<String>,
        pub(super) deny_patterns: Vec<String>,
        pub(super) rewrite_response_model: bool,
        pub(super) script: Option<String>,
    }

    #[derive(FromRow)]
    pub(super) struct TargetRow {
        pub(super) route_id: String,
        pub(super) position: i64,
        pub(super) provider_id: String,
        pub(super) model_id: String,
        pub(super) max_attempts: i16,
    }
}

use rows::{ModelRow, ProjectModelRow, ProjectRow, ProviderRow, RuleRow, TargetRow};
