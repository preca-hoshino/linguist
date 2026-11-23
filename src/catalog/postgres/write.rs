//! Transactional replacement of the active PostgreSQL catalog.

use anyhow::{Result, ensure};
use serde_json::{Value, json};
use sqlx::{Postgres, Transaction};

use super::PgCatalogProvider;
use crate::catalog::{RuntimeCatalog, validation};

/// Current schema rows ordered by resource, then by original configuration order.
#[derive(Default)]
struct CatalogRows {
    /// Providers; keys are represented by stable digests until insertion.
    providers: Vec<Value>,
    /// Provider model rows.
    provider_models: Vec<Value>,
    /// Project rows, with keyed digests rather than plaintext bearer keys.
    projects: Vec<Value>,
    /// Project model rows.
    project_models: Vec<Value>,
    /// Routing rules in evaluation order.
    rules: Vec<Value>,
    /// Static primary and ordered fallback targets.
    targets: Vec<Value>,
}

impl PgCatalogProvider {
    /// Replaces the active catalog if the contents changed and JSON is still the writer.
    ///
    /// # Errors
    /// Returns an error if validation, credential encryption or the transaction fails.
    pub(in crate::catalog) async fn replace_json(
        &self,
        catalog: &RuntimeCatalog,
    ) -> Result<Option<i64>> {
        validation::validate(catalog)?;
        let mut rows = self.prepare_rows(catalog)?;
        let fingerprint = self.secrets.fingerprint(&serde_json::to_vec(&[
            &rows.providers,
            &rows.provider_models,
            &rows.projects,
            &rows.project_models,
            &rows.rules,
            &rows.targets,
        ])?);
        let key_tag = self.secrets.key_tag();
        let mut tx = self.pool.begin().await?;
        let (write_mode, old_fingerprint, old_key_tag) = sqlx::query_as::<
            _,
            (String, Option<Vec<u8>>, Option<Vec<u8>>),
        >(
            "SELECT write_mode,fingerprint,key_tag FROM catalog_state WHERE singleton FOR UPDATE",
        )
        .fetch_one(&mut *tx)
        .await?;
        if write_mode != "json_sync" {
            tx.commit().await?;
            return Ok(None);
        }
        ensure!(
            old_key_tag.is_none_or(|tag| tag.as_slice() == key_tag),
            "LINGUIST_CATALOG_KEY does not match the PostgreSQL catalog"
        );
        if old_fingerprint.as_deref() == Some(fingerprint.as_slice()) {
            sqlx::query("UPDATE catalog_state SET sync_error = NULL WHERE singleton AND sync_error IS NOT NULL")
                .execute(&mut *tx).await?;
            tx.commit().await?;
            return Ok(None);
        }

        for (row, provider) in rows.providers.iter_mut().zip(&catalog.providers) {
            row["encrypted_key"] = json!(
                self.secrets
                    .seal_provider(&provider.id, &provider.api_key)?
                    .map(|encrypted| bytea(&encrypted))
            );
        }
        rows.replace(&mut tx).await?;
        let revision = sqlx::query_scalar::<_, i64>(
            "UPDATE catalog_state SET revision = revision + 1, fingerprint = $1, key_tag = $2, \
             updated_at = NOW(), sync_error = NULL WHERE singleton RETURNING revision",
        )
        .bind(fingerprint.as_slice())
        .bind(key_tag.as_slice())
        .fetch_one(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(Some(revision))
    }

    /// Flattens validated objects; only the order of semantically ordered arrays is retained.
    fn prepare_rows(&self, catalog: &RuntimeCatalog) -> Result<CatalogRows> {
        let mut rows = CatalogRows::default();
        for (position, provider) in catalog.providers.iter().enumerate() {
            let key_fingerprint = self.secrets.fingerprint(provider.api_key.as_bytes());
            rows.providers.push(json!({
                "id": provider.id, "position": position, "name": provider.name, "icon": provider.icon,
                "vendor": provider.vendor, "api_type": provider.api_type, "script": provider.script,
                "encrypted_key": bytea(&key_fingerprint),
            }));
            for (position, model) in provider.models.iter().enumerate() {
                rows.provider_models.push(json!({
                    "provider_id": provider.id, "id": model.id, "position": position,
                    "name": model.name, "icon": model.icon, "url": model.url, "script": model.script,
                    "supports_reasoning_effort": model.supports_reasoning_effort,
                    "tool_calling": model.tool_calling, "vision": model.vision,
                    "thinking": model.thinking, "streaming": model.streaming,
                    "max_input_tokens": model.max_input_tokens, "max_output_tokens": model.max_output_tokens,
                }));
            }
        }
        for (position, project) in catalog.projects.iter().enumerate() {
            let key = project
                .api_key
                .as_deref()
                .filter(|key| !key.trim().is_empty());
            let Some(key) = key else {
                anyhow::bail!("project '{}' needs an apiKey", project.id);
            };
            let digest = self.secrets.digest_project(&project.id, key);
            rows.projects.push(json!({
                "id": project.id, "position": position, "name": project.name, "icon": project.icon,
                "key_digest": bytea(&digest), "meta": project.meta, "script": project.script,
            }));
            for (position, model) in project.call_models.iter().enumerate() {
                rows.project_models.push(json!({
                    "project_id": project.id, "id": model.id, "position": position,
                    "name": model.name, "icon": model.icon, "meta": model.meta, "script": model.script,
                }));
            }
        }
        for (position, rule) in catalog.routes.iter().enumerate() {
            rows.rules.push(json!({
                "id": rule.id, "position": position, "name": rule.name, "enabled": rule.enabled,
                "priority": rule.priority, "project_ids": rule.match_rule.project_ids,
                "call_model_ids": rule.match_rule.call_model_ids, "allow_patterns": rule.candidates.allow,
                "deny_patterns": rule.candidates.deny, "rewrite_response_model": rule.rewrite_response_model,
                "script": rule.script,
            }));
            for (position, target) in rule
                .target
                .iter()
                .map(|t| (0, t))
                .chain(rule.fallbacks.iter().enumerate().map(|(n, t)| (n + 1, t)))
            {
                rows.targets.push(json!({
                    "route_id": rule.id, "position": position, "provider_id": target.provider_id,
                    "model_id": target.model_id, "max_attempts": target.max_attempts,
                }));
            }
        }
        Ok(rows)
    }
}

impl CatalogRows {
    /// Deletes children first, then bulk-inserts parents first, without touching telemetry.
    async fn replace(&self, tx: &mut Transaction<'_, Postgres>) -> Result<()> {
        let tables = [
            (
                "catalog_providers",
                "id,position,name,icon,vendor,api_type,encrypted_key,script",
                &self.providers,
            ),
            (
                "catalog_provider_models",
                "provider_id,id,position,name,icon,url,supports_reasoning_effort,tool_calling,vision,thinking,streaming,max_input_tokens,max_output_tokens,script",
                &self.provider_models,
            ),
            (
                "catalog_projects",
                "id,position,name,icon,key_digest,meta,script",
                &self.projects,
            ),
            (
                "catalog_project_models",
                "project_id,id,position,name,icon,meta,script",
                &self.project_models,
            ),
            (
                "catalog_route_rules",
                "id,position,name,enabled,priority,project_ids,call_model_ids,allow_patterns,deny_patterns,rewrite_response_model,script",
                &self.rules,
            ),
            (
                "catalog_route_targets",
                "route_id,position,provider_id,model_id,max_attempts",
                &self.targets,
            ),
        ];
        for (table, _, _) in tables.iter().rev() {
            sqlx::query(&format!("DELETE FROM {table}"))
                .execute(&mut **tx)
                .await?;
        }
        for (table, columns, rows) in tables {
            if rows.is_empty() {
                continue;
            }
            sqlx::query(&format!(
                "INSERT INTO {table} ({columns}) \
                SELECT {columns} FROM jsonb_populate_recordset(NULL::{table}, $1)"
            ))
            .bind(sqlx::types::Json(rows))
            .execute(&mut **tx)
            .await?;
        }
        Ok(())
    }
}

/// PostgreSQL bytea's hex input representation, used only in parameterized bulk writes.
fn bytea(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut text = String::with_capacity(2 + bytes.len() * 2);
    text.push_str("\\x");
    for byte in bytes {
        let _ = write!(text, "{byte:02x}");
    }
    text
}
