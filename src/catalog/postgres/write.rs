//! Transactional CRUD, script compilation validation, and reordering for PostgreSQL catalog.

use anyhow::{Context, Result, anyhow, bail, ensure};
use serde::Deserialize;
use sqlx::{Postgres, Transaction};

use super::PgCatalogProvider;
use super::validation::validate_script_items;
use crate::catalog::read::Resource;
use crate::models::{CompiledScriptChain, ScriptItem, infer_model_icon, infer_provider_icon};

/// Payload for creating or updating a Provider.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderWriteInput {
    /// Provider ID.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Optional icon slug (auto-inferred when blank).
    #[serde(default)]
    pub icon: String,
    /// Enabled flag.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Optional API key (on update, `None` or empty preserves existing sealed key unless `clear_api_key` is true).
    #[serde(default)]
    pub api_key: Option<String>,
    /// Explicitly clears stored provider API key when updating.
    #[serde(default)]
    pub clear_api_key: bool,
    /// Ordered script chain.
    #[serde(default)]
    pub scripts: Vec<ScriptItem>,
    /// Optional optimistic concurrency revision.
    #[serde(default)]
    pub expected_revision: Option<i64>,
}

/// Payload for creating or updating a `ProviderModel`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelWriteInput {
    /// Parent provider ID.
    pub provider_id: String,
    /// Model ID.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Optional icon slug (auto-inferred when blank).
    #[serde(default)]
    pub icon: String,
    /// Enabled flag.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Ordered script chain.
    #[serde(default)]
    pub scripts: Vec<ScriptItem>,
    /// Optional optimistic concurrency revision.
    #[serde(default)]
    pub expected_revision: Option<i64>,
}

/// Payload for creating or updating a Project.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectWriteInput {
    /// Project ID (`^[A-Za-z0-9_-]+$`).
    pub id: String,
    /// Display name.
    pub name: String,
    /// Optional icon slug (auto-inferred when blank).
    #[serde(default)]
    pub icon: String,
    /// Enabled flag.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Plaintext project Bearer API key.
    pub api_key: String,
    /// Ordered script chain.
    #[serde(default)]
    pub scripts: Vec<ScriptItem>,
    /// Optional optimistic concurrency revision.
    #[serde(default)]
    pub expected_revision: Option<i64>,
}

/// Payload for creating or updating a Project `CallModel`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectModelWriteInput {
    /// Parent project ID.
    pub project_id: String,
    /// Call model ID.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Optional icon slug (auto-inferred when blank).
    #[serde(default)]
    pub icon: String,
    /// Enabled flag.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Ordered script chain.
    #[serde(default)]
    pub scripts: Vec<ScriptItem>,
    /// Optional optimistic concurrency revision.
    #[serde(default)]
    pub expected_revision: Option<i64>,
}

/// Payload for creating or updating a `RouteRule`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteWriteInput {
    /// Route ID.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Optional icon slug (defaults to `"route"`).
    #[serde(default)]
    pub icon: String,
    /// Enabled flag.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Ordered script chain.
    #[serde(default)]
    pub scripts: Vec<ScriptItem>,
    /// Optional optimistic concurrency revision.
    #[serde(default)]
    pub expected_revision: Option<i64>,
}

/// Helper default `true`.
const fn default_true() -> bool {
    true
}

impl PgCatalogProvider {
    /// Compiles and validates a script chain off the async runtime.
    async fn compile_and_validate_scripts(
        &self,
        scripts: &[ScriptItem],
        owner: &str,
    ) -> Result<CompiledScriptChain> {
        validate_script_items(scripts, owner)?;
        let engine = self.engine.clone();
        let list = scripts.to_vec();
        tokio::task::spawn_blocking(move || engine.compile_chain(&list))
            .await
            .context("script compilation task panicked")?
    }

    /// Locks `catalog_state`, validates `key_tag` and `expected_revision`, and increments revision.
    async fn bump_revision(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        expected_revision: Option<i64>,
    ) -> Result<i64> {
        let (revision, key_tag) = sqlx::query_as::<_, (i64, Option<Vec<u8>>)>(
            "SELECT revision, key_tag FROM catalog_state WHERE singleton FOR UPDATE",
        )
        .fetch_one(&mut **tx)
        .await?;

        if let Some(expected) = expected_revision
            && revision != expected
        {
            bail!("conflict: catalog revision changed (expected {expected}, current {revision})");
        }

        let our_tag = self.secrets.key_tag();
        if let Some(existing_tag) = key_tag.as_deref() {
            ensure!(
                existing_tag == our_tag.as_slice(),
                "LINGUIST_CATALOG_KEY does not match the PostgreSQL catalog"
            );
        }

        let new_rev = sqlx::query_scalar::<_, i64>(
            "UPDATE catalog_state \
             SET revision = revision + 1, key_tag = COALESCE(key_tag, $1), updated_at = NOW() \
             WHERE singleton RETURNING revision",
        )
        .bind(our_tag.as_slice())
        .fetch_one(&mut **tx)
        .await?;

        Ok(new_rev)
    }

    /// Creates a new provider and returns the committed revision.
    ///
    /// # Errors
    /// Returns an error on duplicate ID, invalid script, or database error.
    pub async fn create_provider(&self, input: ProviderWriteInput) -> Result<i64> {
        let id = input.id.trim().to_string();
        ensure!(!id.is_empty(), "provider id must not be blank");
        let name = input.name.trim().to_string();
        ensure!(!name.is_empty(), "provider name must not be blank");
        let icon = resolve_icon(&input.icon, || infer_provider_icon(&id, &name));
        let compiled = self
            .compile_and_validate_scripts(&input.scripts, &format!("provider '{id}'"))
            .await?;
        let sealed = self
            .secrets
            .seal_provider(&id, input.api_key.as_deref().unwrap_or(""))?;

        let mut tx = self.pool.begin().await?;
        let rev = self.bump_revision(&mut tx, input.expected_revision).await?;
        let next_pos: i64 =
            sqlx::query_scalar("SELECT COALESCE(MAX(position) + 1, 0) FROM catalog_providers")
                .fetch_one(&mut *tx)
                .await?;

        sqlx::query(
            "INSERT INTO catalog_providers \
             (id, position, name, icon, enabled, encrypted_key, scripts, derived_tags, derived_meta, derived_hooks, updated_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())",
        )
        .bind(&id)
        .bind(next_pos)
        .bind(&name)
        .bind(&icon)
        .bind(input.enabled)
        .bind(sealed)
        .bind(sqlx::types::Json(&input.scripts))
        .bind(&compiled.tags)
        .bind(sqlx::types::Json(&compiled.meta))
        .bind(&compiled.hooks)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(rev)
    }

    /// Updates an existing provider and returns the committed revision.
    ///
    /// # Errors
    /// Returns an error if the provider does not exist, script compilation fails, or revision conflicts.
    pub async fn update_provider(&self, input: ProviderWriteInput) -> Result<i64> {
        let id = input.id.trim().to_string();
        let name = input.name.trim().to_string();
        ensure!(!name.is_empty(), "provider name must not be blank");
        let icon = resolve_icon(&input.icon, || infer_provider_icon(&id, &name));
        let compiled = self
            .compile_and_validate_scripts(&input.scripts, &format!("provider '{id}'"))
            .await?;

        let mut tx = self.pool.begin().await?;
        let rev = self.bump_revision(&mut tx, input.expected_revision).await?;

        let existing_key: Option<Option<Vec<u8>>> = sqlx::query_scalar(
            "SELECT encrypted_key FROM catalog_providers WHERE id = $1 FOR UPDATE",
        )
        .bind(&id)
        .fetch_optional(&mut *tx)
        .await?;

        let Some(old_key) = existing_key else {
            bail!("not_found: provider '{id}' does not exist");
        };

        let new_sealed = if input.clear_api_key {
            None
        } else if let Some(raw_key) = input.api_key.as_deref().filter(|s| !s.is_empty()) {
            self.secrets.seal_provider(&id, raw_key)?
        } else {
            old_key
        };

        sqlx::query(
            "UPDATE catalog_providers \
             SET name = $2, icon = $3, enabled = $4, encrypted_key = $5, scripts = $6, \
                 derived_tags = $7, derived_meta = $8, derived_hooks = $9, updated_at = NOW() \
             WHERE id = $1",
        )
        .bind(&id)
        .bind(&name)
        .bind(&icon)
        .bind(input.enabled)
        .bind(new_sealed)
        .bind(sqlx::types::Json(&input.scripts))
        .bind(&compiled.tags)
        .bind(sqlx::types::Json(&compiled.meta))
        .bind(&compiled.hooks)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(rev)
    }

    /// Creates a new provider model and returns the committed revision.
    ///
    /// # Errors
    /// Returns an error if parent provider is missing, ID collides, or script compilation fails.
    pub async fn create_provider_model(&self, input: ProviderModelWriteInput) -> Result<i64> {
        let pid = input.provider_id.trim().to_string();
        let id = input.id.trim().to_string();
        ensure!(
            !pid.is_empty() && !id.is_empty(),
            "providerId and id are required"
        );
        let name = input.name.trim().to_string();
        ensure!(!name.is_empty(), "model name must not be blank");
        let compiled = self
            .compile_and_validate_scripts(&input.scripts, &format!("model '{pid}/{id}'"))
            .await?;

        let mut tx = self.pool.begin().await?;
        let rev = self.bump_revision(&mut tx, input.expected_revision).await?;
        let parent_icon: Option<String> =
            sqlx::query_scalar("SELECT icon FROM catalog_providers WHERE id = $1")
                .bind(&pid)
                .fetch_optional(&mut *tx)
                .await?;
        let Some(p_icon) = parent_icon else {
            bail!("not_found: provider '{pid}' does not exist");
        };
        let icon = resolve_icon(&input.icon, || infer_model_icon(&id, &name, &p_icon));

        let next_pos: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM catalog_provider_models WHERE provider_id = $1",
        )
        .bind(&pid)
        .fetch_one(&mut *tx)
        .await?;

        sqlx::query(
            "INSERT INTO catalog_provider_models \
             (provider_id, id, position, name, icon, enabled, scripts, derived_tags, derived_meta, derived_hooks, updated_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())",
        )
        .bind(&pid)
        .bind(&id)
        .bind(next_pos)
        .bind(&name)
        .bind(&icon)
        .bind(input.enabled)
        .bind(sqlx::types::Json(&input.scripts))
        .bind(&compiled.tags)
        .bind(sqlx::types::Json(&compiled.meta))
        .bind(&compiled.hooks)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(rev)
    }

    /// Updates an existing provider model and returns the committed revision.
    ///
    /// # Errors
    /// Returns an error if the model does not exist or script compilation fails.
    pub async fn update_provider_model(&self, input: ProviderModelWriteInput) -> Result<i64> {
        let pid = input.provider_id.trim().to_string();
        let id = input.id.trim().to_string();
        let name = input.name.trim().to_string();
        ensure!(!name.is_empty(), "model name must not be blank");
        let compiled = self
            .compile_and_validate_scripts(&input.scripts, &format!("model '{pid}/{id}'"))
            .await?;

        let mut tx = self.pool.begin().await?;
        let rev = self.bump_revision(&mut tx, input.expected_revision).await?;
        let parent_icon: Option<String> =
            sqlx::query_scalar("SELECT icon FROM catalog_providers WHERE id = $1")
                .bind(&pid)
                .fetch_optional(&mut *tx)
                .await?;
        let p_icon = parent_icon.unwrap_or_else(|| pid.clone());
        let icon = resolve_icon(&input.icon, || infer_model_icon(&id, &name, &p_icon));

        let res = sqlx::query(
            "UPDATE catalog_provider_models \
             SET name = $3, icon = $4, enabled = $5, scripts = $6, \
                 derived_tags = $7, derived_meta = $8, derived_hooks = $9, updated_at = NOW() \
             WHERE provider_id = $1 AND id = $2",
        )
        .bind(&pid)
        .bind(&id)
        .bind(&name)
        .bind(&icon)
        .bind(input.enabled)
        .bind(sqlx::types::Json(&input.scripts))
        .bind(&compiled.tags)
        .bind(sqlx::types::Json(&compiled.meta))
        .bind(&compiled.hooks)
        .execute(&mut *tx)
        .await?;

        if res.rows_affected() == 0 {
            bail!("not_found: model '{pid}/{id}' does not exist");
        }
        tx.commit().await?;
        Ok(rev)
    }

    /// Creates a new project with plaintext `apiKey` and returns the committed revision.
    ///
    /// # Errors
    /// Returns an error if ID/key is invalid or script compilation fails.
    pub async fn create_project(&self, input: ProjectWriteInput) -> Result<i64> {
        let id = input.id.trim().to_string();
        ensure!(!id.is_empty(), "project id must not be blank");
        let name = input.name.trim().to_string();
        ensure!(!name.is_empty(), "project name must not be blank");
        let api_key = input.api_key.trim().to_string();
        ensure!(!api_key.is_empty(), "project apiKey must not be empty");
        let icon = resolve_icon(&input.icon, || "copilot-color".to_string());
        let compiled = self
            .compile_and_validate_scripts(&input.scripts, &format!("project '{id}'"))
            .await?;

        let mut tx = self.pool.begin().await?;
        let rev = self.bump_revision(&mut tx, input.expected_revision).await?;
        let next_pos: i64 =
            sqlx::query_scalar("SELECT COALESCE(MAX(position) + 1, 0) FROM catalog_projects")
                .fetch_one(&mut *tx)
                .await?;

        sqlx::query(
            "INSERT INTO catalog_projects \
             (id, position, name, icon, enabled, api_key, scripts, derived_tags, derived_meta, derived_hooks, updated_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())",
        )
        .bind(&id)
        .bind(next_pos)
        .bind(&name)
        .bind(&icon)
        .bind(input.enabled)
        .bind(&api_key)
        .bind(sqlx::types::Json(&input.scripts))
        .bind(&compiled.tags)
        .bind(sqlx::types::Json(&compiled.meta))
        .bind(&compiled.hooks)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(rev)
    }

    /// Updates an existing project and returns the committed revision.
    ///
    /// # Errors
    /// Returns an error if the project does not exist, key is empty, or scripts fail compilation.
    pub async fn update_project(&self, input: ProjectWriteInput) -> Result<i64> {
        let id = input.id.trim().to_string();
        let name = input.name.trim().to_string();
        ensure!(!name.is_empty(), "project name must not be blank");
        let api_key = input.api_key.trim().to_string();
        ensure!(!api_key.is_empty(), "project apiKey must not be empty");
        let icon = resolve_icon(&input.icon, || "copilot-color".to_string());
        let compiled = self
            .compile_and_validate_scripts(&input.scripts, &format!("project '{id}'"))
            .await?;

        let mut tx = self.pool.begin().await?;
        let rev = self.bump_revision(&mut tx, input.expected_revision).await?;

        let res = sqlx::query(
            "UPDATE catalog_projects \
             SET name = $2, icon = $3, enabled = $4, api_key = $5, scripts = $6, \
                 derived_tags = $7, derived_meta = $8, derived_hooks = $9, updated_at = NOW() \
             WHERE id = $1",
        )
        .bind(&id)
        .bind(&name)
        .bind(&icon)
        .bind(input.enabled)
        .bind(&api_key)
        .bind(sqlx::types::Json(&input.scripts))
        .bind(&compiled.tags)
        .bind(sqlx::types::Json(&compiled.meta))
        .bind(&compiled.hooks)
        .execute(&mut *tx)
        .await?;

        if res.rows_affected() == 0 {
            bail!("not_found: project '{id}' does not exist");
        }
        tx.commit().await?;
        Ok(rev)
    }

    /// Creates a new call model under a project and returns the committed revision.
    ///
    /// # Errors
    /// Returns an error if parent project is missing, ID is `"*"`, or scripts fail compilation.
    pub async fn create_project_model(&self, input: ProjectModelWriteInput) -> Result<i64> {
        let pid = input.project_id.trim().to_string();
        let id = input.id.trim().to_string();
        ensure!(
            !pid.is_empty() && !id.is_empty(),
            "projectId and id are required"
        );
        ensure!(id != "*", "callModel id '*' is not allowed");
        let name = input.name.trim().to_string();
        ensure!(!name.is_empty(), "callModel name must not be blank");
        let compiled = self
            .compile_and_validate_scripts(&input.scripts, &format!("callModel '{pid}/{id}'"))
            .await?;

        let mut tx = self.pool.begin().await?;
        let rev = self.bump_revision(&mut tx, input.expected_revision).await?;
        let parent_icon: Option<String> =
            sqlx::query_scalar("SELECT icon FROM catalog_projects WHERE id = $1")
                .bind(&pid)
                .fetch_optional(&mut *tx)
                .await?;
        let Some(p_icon) = parent_icon else {
            bail!("not_found: project '{pid}' does not exist");
        };
        let icon = resolve_icon(&input.icon, || infer_model_icon(&id, &name, &p_icon));

        let next_pos: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM catalog_project_models WHERE project_id = $1",
        )
        .bind(&pid)
        .fetch_one(&mut *tx)
        .await?;

        sqlx::query(
            "INSERT INTO catalog_project_models \
             (project_id, id, position, name, icon, enabled, scripts, derived_tags, derived_meta, derived_hooks, updated_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())",
        )
        .bind(&pid)
        .bind(&id)
        .bind(next_pos)
        .bind(&name)
        .bind(&icon)
        .bind(input.enabled)
        .bind(sqlx::types::Json(&input.scripts))
        .bind(&compiled.tags)
        .bind(sqlx::types::Json(&compiled.meta))
        .bind(&compiled.hooks)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(rev)
    }

    /// Updates an existing call model and returns the committed revision.
    ///
    /// # Errors
    /// Returns an error if the call model does not exist or scripts fail compilation.
    pub async fn update_project_model(&self, input: ProjectModelWriteInput) -> Result<i64> {
        let pid = input.project_id.trim().to_string();
        let id = input.id.trim().to_string();
        let name = input.name.trim().to_string();
        ensure!(!name.is_empty(), "callModel name must not be blank");
        let compiled = self
            .compile_and_validate_scripts(&input.scripts, &format!("callModel '{pid}/{id}'"))
            .await?;

        let mut tx = self.pool.begin().await?;
        let rev = self.bump_revision(&mut tx, input.expected_revision).await?;
        let parent_icon: Option<String> =
            sqlx::query_scalar("SELECT icon FROM catalog_projects WHERE id = $1")
                .bind(&pid)
                .fetch_optional(&mut *tx)
                .await?;
        let p_icon = parent_icon.unwrap_or_else(|| "copilot-color".to_string());
        let icon = resolve_icon(&input.icon, || infer_model_icon(&id, &name, &p_icon));

        let res = sqlx::query(
            "UPDATE catalog_project_models \
             SET name = $3, icon = $4, enabled = $5, scripts = $6, \
                 derived_tags = $7, derived_meta = $8, derived_hooks = $9, updated_at = NOW() \
             WHERE project_id = $1 AND id = $2",
        )
        .bind(&pid)
        .bind(&id)
        .bind(&name)
        .bind(&icon)
        .bind(input.enabled)
        .bind(sqlx::types::Json(&input.scripts))
        .bind(&compiled.tags)
        .bind(sqlx::types::Json(&compiled.meta))
        .bind(&compiled.hooks)
        .execute(&mut *tx)
        .await?;

        if res.rows_affected() == 0 {
            bail!("not_found: callModel '{pid}/{id}' does not exist");
        }
        tx.commit().await?;
        Ok(rev)
    }

    /// Creates a new route rule at the end of the route chain and returns the committed revision.
    ///
    /// # Errors
    /// Returns an error if ID is blank or scripts fail compilation.
    pub async fn create_route(&self, input: RouteWriteInput) -> Result<i64> {
        let id = input.id.trim().to_string();
        ensure!(!id.is_empty(), "route id must not be blank");
        let name = input.name.trim().to_string();
        ensure!(!name.is_empty(), "route name must not be blank");
        let icon = resolve_icon(&input.icon, || "openrouter".to_string());
        let compiled = self
            .compile_and_validate_scripts(&input.scripts, &format!("route '{id}'"))
            .await?;

        let mut tx = self.pool.begin().await?;
        let rev = self.bump_revision(&mut tx, input.expected_revision).await?;
        let next_pos: i64 =
            sqlx::query_scalar("SELECT COALESCE(MAX(position) + 1, 0) FROM catalog_route_rules")
                .fetch_one(&mut *tx)
                .await?;

        sqlx::query(
            "INSERT INTO catalog_route_rules \
             (id, position, name, icon, enabled, scripts, derived_tags, derived_meta, derived_hooks, updated_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())",
        )
        .bind(&id)
        .bind(next_pos)
        .bind(&name)
        .bind(&icon)
        .bind(input.enabled)
        .bind(sqlx::types::Json(&input.scripts))
        .bind(&compiled.tags)
        .bind(sqlx::types::Json(&compiled.meta))
        .bind(&compiled.hooks)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(rev)
    }

    /// Updates an existing route rule and returns the committed revision.
    ///
    /// # Errors
    /// Returns an error if the route does not exist or scripts fail compilation.
    pub async fn update_route(&self, input: RouteWriteInput) -> Result<i64> {
        let id = input.id.trim().to_string();
        let name = input.name.trim().to_string();
        ensure!(!name.is_empty(), "route name must not be blank");
        let icon = resolve_icon(&input.icon, || "openrouter".to_string());
        let compiled = self
            .compile_and_validate_scripts(&input.scripts, &format!("route '{id}'"))
            .await?;

        let mut tx = self.pool.begin().await?;
        let rev = self.bump_revision(&mut tx, input.expected_revision).await?;

        let res = sqlx::query(
            "UPDATE catalog_route_rules \
             SET name = $2, icon = $3, enabled = $4, scripts = $5, \
                 derived_tags = $6, derived_meta = $7, derived_hooks = $8, updated_at = NOW() \
             WHERE id = $1",
        )
        .bind(&id)
        .bind(&name)
        .bind(&icon)
        .bind(input.enabled)
        .bind(sqlx::types::Json(&input.scripts))
        .bind(&compiled.tags)
        .bind(sqlx::types::Json(&compiled.meta))
        .bind(&compiled.hooks)
        .execute(&mut *tx)
        .await?;

        if res.rows_affected() == 0 {
            bail!("not_found: route '{id}' does not exist");
        }
        tx.commit().await?;
        Ok(rev)
    }

    /// Deletes one catalog item (refusing parent deletion if children exist).
    ///
    /// # Errors
    /// Returns an error if the entity does not exist or still has child records.
    pub async fn delete_resource(
        &self,
        resource: Resource,
        id: &str,
        parent_id: Option<&str>,
        expected_revision: Option<i64>,
    ) -> Result<i64> {
        let mut tx = self.pool.begin().await?;
        let rev = self.bump_revision(&mut tx, expected_revision).await?;

        let affected = match resource {
            Resource::Providers => {
                let child_cnt: i64 = sqlx::query_scalar(
                    "SELECT count(*) FROM catalog_provider_models WHERE provider_id = $1",
                )
                .bind(id)
                .fetch_one(&mut *tx)
                .await?;
                ensure!(
                    child_cnt == 0,
                    "has_children: provider '{id}' still has {child_cnt} models; delete them first"
                );
                sqlx::query("DELETE FROM catalog_providers WHERE id = $1")
                    .bind(id)
                    .execute(&mut *tx)
                    .await?
                    .rows_affected()
            }
            Resource::ProviderModels => {
                let pid = parent_id.ok_or_else(|| anyhow!("provider_id is required"))?;
                sqlx::query(
                    "DELETE FROM catalog_provider_models WHERE provider_id = $1 AND id = $2",
                )
                .bind(pid)
                .bind(id)
                .execute(&mut *tx)
                .await?
                .rows_affected()
            }
            Resource::Projects => {
                let child_cnt: i64 = sqlx::query_scalar(
                    "SELECT count(*) FROM catalog_project_models WHERE project_id = $1",
                )
                .bind(id)
                .fetch_one(&mut *tx)
                .await?;
                ensure!(
                    child_cnt == 0,
                    "has_children: project '{id}' still has {child_cnt} call models; delete them first"
                );
                sqlx::query("DELETE FROM catalog_projects WHERE id = $1")
                    .bind(id)
                    .execute(&mut *tx)
                    .await?
                    .rows_affected()
            }
            Resource::ProjectModels => {
                let pid = parent_id.ok_or_else(|| anyhow!("project_id is required"))?;
                sqlx::query("DELETE FROM catalog_project_models WHERE project_id = $1 AND id = $2")
                    .bind(pid)
                    .bind(id)
                    .execute(&mut *tx)
                    .await?
                    .rows_affected()
            }
            Resource::Routes => sqlx::query("DELETE FROM catalog_route_rules WHERE id = $1")
                .bind(id)
                .execute(&mut *tx)
                .await?
                .rows_affected(),
        };

        if affected == 0 {
            bail!("not_found: target '{id}' does not exist");
        }
        tx.commit().await?;
        Ok(rev)
    }

    /// Reorders all entries in a resource table according to `ordered_ids` (using negative temp
    /// positions first to satisfy `UNIQUE(position)` constraints cleanly).
    ///
    /// # Errors
    /// Returns an error if `ordered_ids` does not match existing rows or on DB failure.
    pub async fn reorder_resource(
        &self,
        resource: Resource,
        parent_id: Option<&str>,
        ordered_ids: &[String],
        expected_revision: Option<i64>,
    ) -> Result<i64> {
        ensure!(!ordered_ids.is_empty(), "orderedIds must not be empty");
        let mut tx = self.pool.begin().await?;
        let rev = self.bump_revision(&mut tx, expected_revision).await?;

        let (table, parent_col) = match resource {
            Resource::Providers => ("catalog_providers", None),
            Resource::ProviderModels => ("catalog_provider_models", Some("provider_id")),
            Resource::Projects => ("catalog_projects", None),
            Resource::ProjectModels => ("catalog_project_models", Some("project_id")),
            Resource::Routes => ("catalog_route_rules", None),
        };

        let existing: Vec<String> = if let Some(col) = parent_col {
            let pid = parent_id.ok_or_else(|| anyhow!("{col} is required"))?;
            sqlx::query_scalar(&format!(
                "SELECT id FROM {table} WHERE {col} = $1 ORDER BY position"
            ))
            .bind(pid)
            .fetch_all(&mut *tx)
            .await?
        } else {
            sqlx::query_scalar(&format!("SELECT id FROM {table} ORDER BY position"))
                .fetch_all(&mut *tx)
                .await?
        };

        ensure!(
            existing.len() == ordered_ids.len()
                && existing.iter().all(|id| ordered_ids.contains(id)),
            "orderedIds must contain the exact set of existing IDs"
        );

        // Shift to high offset first to avoid UNIQUE(position) collisions during swap.
        let offset = 1_000_000_i64;
        for (idx, item_id) in ordered_ids.iter().enumerate() {
            let temp_pos = offset + i64::try_from(idx).unwrap_or(0);
            if let Some(col) = parent_col {
                let pid = parent_id.unwrap_or_default();
                sqlx::query(&format!(
                    "UPDATE {table} SET position = $3 WHERE {col} = $1 AND id = $2"
                ))
                .bind(pid)
                .bind(item_id)
                .bind(temp_pos)
                .execute(&mut *tx)
                .await?;
            } else {
                sqlx::query(&format!("UPDATE {table} SET position = $2 WHERE id = $1"))
                    .bind(item_id)
                    .bind(temp_pos)
                    .execute(&mut *tx)
                    .await?;
            }
        }

        for (idx, item_id) in ordered_ids.iter().enumerate() {
            let final_pos = i64::try_from(idx).unwrap_or(0);
            if let Some(col) = parent_col {
                let pid = parent_id.unwrap_or_default();
                sqlx::query(&format!(
                    "UPDATE {table} SET position = $3, updated_at = NOW() WHERE {col} = $1 AND id = $2"
                ))
                .bind(pid)
                .bind(item_id)
                .bind(final_pos)
                .execute(&mut *tx)
                .await?;
            } else {
                sqlx::query(&format!(
                    "UPDATE {table} SET position = $2, updated_at = NOW() WHERE id = $1"
                ))
                .bind(item_id)
                .bind(final_pos)
                .execute(&mut *tx)
                .await?;
            }
        }

        tx.commit().await?;
        Ok(rev)
    }

    /// Seeds a showcase v0.2.0 catalog (`DeepSeek` peak/off-peak, Volcengine cache TTL, Coding route)
    /// when the database has `revision == 0`.
    ///
    /// # Errors
    /// Returns an error if catalog insertion fails.
    #[allow(clippy::too_many_lines)]
    pub async fn seed_demo_catalog_if_empty(&self) -> Result<bool> {
        if self.revision().await? > 0 {
            return Ok(false);
        }

        self.create_provider(ProviderWriteInput {
            id: "deepseek".to_string(),
            name: "深度求索".to_string(),
            icon: "deepseek-color".to_string(),
            enabled: true,
            api_key: Some("sk-demo-deepseek-key".to_string()),
            clear_api_key: false,
            scripts: vec![ScriptItem {
                id: "deepseek-peak".to_string(),
                name: "峰谷动态计费".to_string(),
                enabled: true,
                code: r#"export const meta = { baseUrl: "https://api.deepseek.com", currency: "CNY" };
export function onBilling(b: BillingContext): void {
  const p = b.model.meta.pricing as { input: string; cacheHit: string; output: string } | undefined;
  if (!p || !b.rawUsage) return;
  const started = new Date(b.requestStartedAtUtc);
  const utcMins = started.getUTCHours() * 60 + started.getUTCMinutes();
  const isOffPeak = utcMins >= 16 * 60 + 30 || utcMins < 30;
  const rate = isOffPeak ? "0.5" : "1";
  const hit = b.tokens.cacheRead;
  const miss = Math.max(0, b.tokens.input - hit);
  b.draft.setCurrency("CNY");
  b.draft.addInput("未命中缓存输入", linguist.decMul(linguist.costPerMillion(miss, p.input), rate), `${miss} tok`);
  b.draft.addCacheRead("缓存命中输入", linguist.decMul(linguist.costPerMillion(hit, p.cacheHit), rate), `${hit} tok`);
  b.draft.addOutput("模型输出", linguist.decMul(linguist.costPerMillion(b.tokens.output, p.output), rate), `${b.tokens.output} tok`);
  b.draft.setMeta("billingPeriod", isOffPeak ? "错峰 5 折" : "标准时段");
}"#.to_string(),
            }],
            expected_revision: None,
        })
        .await?;

        self.create_provider_model(ProviderModelWriteInput {
            provider_id: "deepseek".to_string(),
            id: "deepseek-v4-pro".to_string(),
            name: "DeepSeek V4 Pro".to_string(),
            icon: "deepseek-color".to_string(),
            enabled: true,
            scripts: vec![ScriptItem {
                id: "decl".to_string(),
                name: "能力与单价声明".to_string(),
                enabled: true,
                code: r#"export const tags = ["thinking", "tools", "streaming"];
export const meta = {
  maxInputTokens: 1000000,
  maxOutputTokens: 384000,
  pricing: { input: "2.0", cacheHit: "0.5", output: "8.0" }
};"#
                .to_string(),
            }],
            expected_revision: None,
        })
        .await?;

        self.create_project(ProjectWriteInput {
            id: "coding".to_string(),
            name: "VS Code Coding".to_string(),
            icon: "githubcopilot".to_string(),
            enabled: true,
            api_key: "lin-proj-coding-demo".to_string(),
            scripts: vec![ScriptItem {
                id: "budget".to_string(),
                name: "字符预算拦截".to_string(),
                enabled: true,
                code: r"export const meta = { maxCharsLimit: 400000 };
export function onRequest(ctx: ScriptContext): void {
  const limit = Number(ctx.project.meta.maxCharsLimit ?? 400000);
  if (ctx.request.signals.estimatedInputChars > limit) {
    ctx.reject = { statusCode: 400, message: `Exceeded project char budget: ${limit}` };
  }
}"
                .to_string(),
            }],
            expected_revision: None,
        })
        .await?;

        self.create_project_model(ProjectModelWriteInput {
            project_id: "coding".to_string(),
            id: "smart-coder".to_string(),
            name: "Smart Coder".to_string(),
            icon: "cursor".to_string(),
            enabled: true,
            scripts: vec![ScriptItem {
                id: "defaults".to_string(),
                name: "默认参数预设".to_string(),
                enabled: true,
                code: r#"export const meta = { defaultEffort: "high" };
export function onRequest(ctx: ScriptContext): void {
  ctx.request.body.reasoning_effort ??= ctx.callModel.meta.defaultEffort;
}"#
                .to_string(),
            }],
            expected_revision: None,
        })
        .await?;

        self.create_route(RouteWriteInput {
            id: "coding-smart-coder".to_string(),
            name: "编码助手智能极速路由".to_string(),
            icon: "openrouter".to_string(),
            enabled: true,
            scripts: vec![ScriptItem {
                id: "select".to_string(),
                name: "按标签与测速选路".to_string(),
                enabled: true,
                code: r#"export function onRequest(ctx: ScriptContext): void {
  if (ctx.project.id !== "coding" || ctx.callModel.id !== "smart-coder") return;
  const pool = ctx.route.candidates.filter((c) => {
    if (ctx.request.signals.hasVisionImages && !c.model.tags.includes("vision")) return false;
    if (ctx.request.signals.hasTools && !c.model.tags.includes("tools")) return false;
    return true;
  });
  if (pool.length === 0) {
    ctx.reject = { statusCode: 400, message: "No eligible upstream model" };
    return;
  }
  pool.sort((a, b) => (b.metrics.avgDecodeTps ?? 80) - (a.metrics.avgDecodeTps ?? 80));
  ctx.route.rewriteResponseModel = true;
  ctx.route.target = { providerId: pool[0].provider.id, modelId: pool[0].model.id, maxAttempts: 2 };
  ctx.route.fallbacks = pool.slice(1, 3).map((c) => ({ providerId: c.provider.id, modelId: c.model.id }));
}"#.to_string(),
            }],
            expected_revision: None,
        })
        .await?;

        Ok(true)
    }
}

/// Resolves an icon slug, falling back to the derived default if blank.
fn resolve_icon<F>(raw: &str, fallback: F) -> String
where
    F: FnOnce() -> String,
{
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        fallback()
    } else {
        trimmed.to_string()
    }
}
