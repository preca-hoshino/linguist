//! PostgreSQL is the sole authoritative catalog store for Linguist v0.2.0.

pub mod write;

use std::collections::HashMap;

use anyhow::{Context, Result, ensure};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::types::Json;
use sqlx::{FromRow, PgPool, Postgres, Transaction};

use super::secrets::CatalogSecrets;
use super::{CatalogProvider, RuntimeCatalog, validation};
use crate::models::{
    CallModelConfig, ModelConfig, ProjectConfig, ProviderConfig, RouteRuleConfig, ScriptItem,
};
use crate::script_engine::ScriptEngine;

/// PostgreSQL-backed gateway snapshot loader and read/write catalog store.
#[derive(Debug, Clone)]
pub struct PgCatalogProvider {
    /// Database connection pool.
    pub(crate) pool: PgPool,
    /// Instance-wide catalog key material.
    pub(crate) secrets: CatalogSecrets,
    /// Script compiler for validating and extracting `tags`, `meta`, and hooks.
    pub(crate) engine: ScriptEngine,
}

/// Catalog state as reported to the operator.
#[derive(Debug, FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CatalogStatus {
    /// Current database revision; zero means an empty fresh database.
    pub(crate) revision: i64,
    /// Last successful catalog mutation timestamp.
    pub(crate) updated_at: Option<DateTime<Utc>>,
}

impl PgCatalogProvider {
    /// Creates a catalog store using the shared PostgreSQL pool.
    #[must_use]
    pub const fn new(pool: PgPool, secrets: CatalogSecrets, engine: ScriptEngine) -> Self {
        Self {
            pool,
            secrets,
            engine,
        }
    }

    /// Verifies that the database has been upgraded to the v0.2.0 schema before serving traffic.
    ///
    /// # Errors
    /// Returns an error if the database still contains un-migrated v0.1.0 catalog tables.
    pub async fn ensure_v2_schema(&self) -> Result<()> {
        let has_schema_version: bool = sqlx::query_scalar(
            "SELECT EXISTS (\
                SELECT 1 FROM information_schema.columns \
                WHERE table_schema = 'public' AND table_name = 'catalog_state' AND column_name = 'schema_version'\
            )",
        )
        .fetch_one(&self.pool)
        .await?;
        ensure!(
            has_schema_version,
            "Database still contains v0.1.0 catalog data. Stop the service and run `linguist migrate-v02 --projects-json <path>` first."
        );
        Ok(())
    }

    /// Returns the committed revision without loading or compiling scripts.
    ///
    /// # Errors
    /// Returns an error if the query fails.
    pub async fn revision(&self) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar("SELECT revision FROM catalog_state WHERE singleton")
            .fetch_one(&self.pool)
            .await
    }

    /// Reads one committed snapshot consistently from PostgreSQL.
    async fn read_snapshot(&self) -> Result<RawLoadedCatalog> {
        let mut tx = begin_read(&self.pool).await?;
        let (revision, key_tag) = sqlx::query_as::<_, (i64, Option<Vec<u8>>)>(
            "SELECT revision, key_tag FROM catalog_state WHERE singleton",
        )
        .fetch_one(&mut *tx)
        .await?;

        if let Some(tag) = key_tag.as_deref() {
            ensure!(
                tag == self.secrets.key_tag().as_slice(),
                "LINGUIST_CATALOG_KEY does not match the PostgreSQL catalog"
            );
        }

        let providers = self.read_providers(&mut tx).await?;
        let projects = read_projects(&mut tx).await?;
        let routes = read_routes(&mut tx).await?;
        tx.commit().await?;

        Ok(RawLoadedCatalog {
            revision,
            providers,
            projects,
            routes,
        })
    }

    /// Loads supply-side providers and models in configured `position` order.
    async fn read_providers(&self, tx: &mut Transaction<'_, Postgres>) -> Result<Vec<RawProvider>> {
        let mut by_provider: HashMap<String, Vec<RawModel>> = HashMap::new();
        for row in sqlx::query_as::<_, ModelRow>(
            "SELECT provider_id, id, name, icon, enabled, scripts \
             FROM catalog_provider_models ORDER BY provider_id, position",
        )
        .fetch_all(&mut **tx)
        .await?
        {
            by_provider
                .entry(row.provider_id)
                .or_default()
                .push(RawModel {
                    id: row.id,
                    name: row.name,
                    icon: row.icon,
                    enabled: row.enabled,
                    scripts: row.scripts.0,
                });
        }

        let rows = sqlx::query_as::<_, ProviderRow>(
            "SELECT id, name, icon, enabled, encrypted_key, scripts \
             FROM catalog_providers ORDER BY position",
        )
        .fetch_all(&mut **tx)
        .await?;

        rows.into_iter()
            .map(|row| {
                let api_key = self.secrets.open_provider(&row.id, row.encrypted_key)?;
                let models = by_provider.remove(&row.id).unwrap_or_default();
                Ok(RawProvider {
                    id: row.id,
                    name: row.name,
                    icon: row.icon,
                    enabled: row.enabled,
                    api_key,
                    scripts: row.scripts.0,
                    models,
                })
            })
            .collect()
    }
}

#[async_trait]
impl CatalogProvider for PgCatalogProvider {
    async fn load_catalog(&self) -> Result<RuntimeCatalog> {
        self.ensure_v2_schema().await?;
        let raw = self.read_snapshot().await?;
        let engine = self.engine.clone();
        tokio::task::spawn_blocking(move || {
            let mut providers = Vec::with_capacity(raw.providers.len());
            for p in raw.providers {
                let compiled = engine
                    .compile_chain(&p.scripts)
                    .with_context(|| format!("invalid scripts on provider '{}'", p.id))?;
                let mut models = Vec::with_capacity(p.models.len());
                for m in p.models {
                    let m_comp = engine
                        .compile_chain(&m.scripts)
                        .with_context(|| format!("invalid scripts on model '{}/{}'", p.id, m.id))?;
                    models.push(ModelConfig {
                        id: m.id,
                        name: m.name,
                        icon: m.icon,
                        enabled: m.enabled,
                        scripts: m.scripts,
                        compiled: m_comp,
                    });
                }
                providers.push(ProviderConfig {
                    id: p.id,
                    name: p.name,
                    icon: p.icon,
                    enabled: p.enabled,
                    api_key: p.api_key,
                    scripts: p.scripts,
                    compiled,
                    models,
                });
            }

            let mut projects = Vec::with_capacity(raw.projects.len());
            for proj in raw.projects {
                let compiled = engine
                    .compile_chain(&proj.scripts)
                    .with_context(|| format!("invalid scripts on project '{}'", proj.id))?;
                let mut call_models = Vec::with_capacity(proj.call_models.len());
                for cm in proj.call_models {
                    let cm_comp = engine.compile_chain(&cm.scripts).with_context(|| {
                        format!("invalid scripts on callModel '{}/{}'", proj.id, cm.id)
                    })?;
                    call_models.push(CallModelConfig {
                        id: cm.id,
                        name: cm.name,
                        icon: cm.icon,
                        enabled: cm.enabled,
                        scripts: cm.scripts,
                        compiled: cm_comp,
                    });
                }
                projects.push(ProjectConfig {
                    id: proj.id,
                    name: proj.name,
                    icon: proj.icon,
                    enabled: proj.enabled,
                    api_key: proj.api_key,
                    scripts: proj.scripts,
                    compiled,
                    call_models,
                });
            }

            let mut routes = Vec::with_capacity(raw.routes.len());
            for r in raw.routes {
                let compiled = engine
                    .compile_chain(&r.scripts)
                    .with_context(|| format!("invalid scripts on route '{}'", r.id))?;
                routes.push(RouteRuleConfig {
                    id: r.id,
                    name: r.name,
                    icon: r.icon,
                    enabled: r.enabled,
                    position: r.position,
                    scripts: r.scripts,
                    compiled,
                });
            }

            let catalog =
                RuntimeCatalog::new(providers, projects, routes).with_revision(raw.revision);
            validation::validate(&catalog)?;
            Ok(catalog)
        })
        .await
        .context("PostgreSQL catalog compilation task failed")?
    }
}

/// Uses a consistent `REPEATABLE READ` snapshot for reads.
pub(crate) async fn begin_read(pool: &PgPool) -> Result<Transaction<'_, Postgres>, sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    Ok(tx)
}

/// Fetches the database-visible catalog status.
pub(crate) async fn catalog_status(pool: &PgPool) -> Result<CatalogStatus, sqlx::Error> {
    sqlx::query_as("SELECT revision, updated_at FROM catalog_state WHERE singleton")
        .fetch_one(pool)
        .await
}

/// Loads consumer-side projects and call models in `position` order.
async fn read_projects(tx: &mut Transaction<'_, Postgres>) -> Result<Vec<RawProject>> {
    let mut by_project: HashMap<String, Vec<RawCallModel>> = HashMap::new();
    for row in sqlx::query_as::<_, ProjectModelRow>(
        "SELECT project_id, id, name, icon, enabled, scripts \
         FROM catalog_project_models ORDER BY project_id, position",
    )
    .fetch_all(&mut **tx)
    .await?
    {
        by_project
            .entry(row.project_id)
            .or_default()
            .push(RawCallModel {
                id: row.id,
                name: row.name,
                icon: row.icon,
                enabled: row.enabled,
                scripts: row.scripts.0,
            });
    }

    let rows = sqlx::query_as::<_, ProjectRow>(
        "SELECT id, name, icon, enabled, api_key, scripts \
         FROM catalog_projects ORDER BY position",
    )
    .fetch_all(&mut **tx)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let call_models = by_project.remove(&row.id).unwrap_or_default();
            RawProject {
                id: row.id,
                name: row.name,
                icon: row.icon,
                enabled: row.enabled,
                api_key: row.api_key,
                scripts: row.scripts.0,
                call_models,
            }
        })
        .collect())
}

/// Loads routing rules in ascending `position` order.
async fn read_routes(tx: &mut Transaction<'_, Postgres>) -> Result<Vec<RawRoute>> {
    let rows = sqlx::query_as::<_, RuleRow>(
        "SELECT id, name, icon, enabled, position, scripts \
         FROM catalog_route_rules ORDER BY position ASC",
    )
    .fetch_all(&mut **tx)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| RawRoute {
            id: row.id,
            name: row.name,
            icon: row.icon,
            enabled: row.enabled,
            position: row.position,
            scripts: row.scripts.0,
        })
        .collect())
}

/// Uncompiled catalog snapshot read from PostgreSQL.
struct RawLoadedCatalog {
    /// Committed revision.
    revision: i64,
    /// Providers.
    providers: Vec<RawProvider>,
    /// Projects.
    projects: Vec<RawProject>,
    /// Routes.
    routes: Vec<RawRoute>,
}

/// Uncompiled provider row.
struct RawProvider {
    /// ID.
    id: String,
    /// Display name.
    name: String,
    /// Icon slug.
    icon: String,
    /// Enabled flag.
    enabled: bool,
    /// Decrypted API key.
    api_key: String,
    /// Script chain.
    scripts: Vec<ScriptItem>,
    /// Child models.
    models: Vec<RawModel>,
}

/// Uncompiled provider model row.
struct RawModel {
    /// ID.
    id: String,
    /// Display name.
    name: String,
    /// Icon slug.
    icon: String,
    /// Enabled flag.
    enabled: bool,
    /// Script chain.
    scripts: Vec<ScriptItem>,
}

/// Uncompiled project row.
struct RawProject {
    /// ID.
    id: String,
    /// Display name.
    name: String,
    /// Icon slug.
    icon: String,
    /// Enabled flag.
    enabled: bool,
    /// Plaintext API key.
    api_key: String,
    /// Script chain.
    scripts: Vec<ScriptItem>,
    /// Child call models.
    call_models: Vec<RawCallModel>,
}

/// Uncompiled call-model row.
struct RawCallModel {
    /// ID.
    id: String,
    /// Display name.
    name: String,
    /// Icon slug.
    icon: String,
    /// Enabled flag.
    enabled: bool,
    /// Script chain.
    scripts: Vec<ScriptItem>,
}

/// Uncompiled route row.
struct RawRoute {
    /// ID.
    id: String,
    /// Display name.
    name: String,
    /// Icon slug.
    icon: String,
    /// Enabled flag.
    enabled: bool,
    /// Ascending order.
    position: i64,
    /// Script chain.
    scripts: Vec<ScriptItem>,
}

/// Typed SQL row projections.
#[allow(clippy::missing_docs_in_private_items)]
mod rows {
    use super::{FromRow, Json, ScriptItem};

    #[derive(FromRow)]
    pub(super) struct ProviderRow {
        pub(super) id: String,
        pub(super) name: String,
        pub(super) icon: String,
        pub(super) enabled: bool,
        pub(super) encrypted_key: Option<Vec<u8>>,
        pub(super) scripts: Json<Vec<ScriptItem>>,
    }

    #[derive(FromRow)]
    pub(super) struct ModelRow {
        pub(super) provider_id: String,
        pub(super) id: String,
        pub(super) name: String,
        pub(super) icon: String,
        pub(super) enabled: bool,
        pub(super) scripts: Json<Vec<ScriptItem>>,
    }

    #[derive(FromRow)]
    pub(super) struct ProjectRow {
        pub(super) id: String,
        pub(super) name: String,
        pub(super) icon: String,
        pub(super) enabled: bool,
        pub(super) api_key: String,
        pub(super) scripts: Json<Vec<ScriptItem>>,
    }

    #[derive(FromRow)]
    pub(super) struct ProjectModelRow {
        pub(super) project_id: String,
        pub(super) id: String,
        pub(super) name: String,
        pub(super) icon: String,
        pub(super) enabled: bool,
        pub(super) scripts: Json<Vec<ScriptItem>>,
    }

    #[derive(FromRow)]
    pub(super) struct RuleRow {
        pub(super) id: String,
        pub(super) name: String,
        pub(super) icon: String,
        pub(super) enabled: bool,
        pub(super) position: i64,
        pub(super) scripts: Json<Vec<ScriptItem>>,
    }
}

use rows::{ModelRow, ProjectModelRow, ProjectRow, ProviderRow, RuleRow};
