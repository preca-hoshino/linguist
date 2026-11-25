//! One-shot, single-transaction v0.1.0 -> v0.2.0 PostgreSQL catalog migrator.

use std::collections::HashMap;
use std::path::Path;

use anyhow::{Context, Result, ensure};
use ring::rand::{SecureRandom, SystemRandom};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sqlx::types::Json;
use sqlx::{FromRow, PgPool};

use super::secrets::CatalogSecrets;
use crate::models::ScriptItem;
use crate::script_engine::ScriptEngine;

/// Summary returned after running `linguist migrate-v02`.
#[derive(Debug, Clone)]
pub struct MigrationReport {
    /// True if the database was already on v0.2.0.
    pub already_migrated: bool,
    /// Migrated provider count.
    pub providers: usize,
    /// Migrated provider model count.
    pub provider_models: usize,
    /// Migrated project count.
    pub projects: usize,
    /// Migrated project call-model count.
    pub project_models: usize,
    /// Migrated route rule count.
    pub routes: usize,
    /// Projects whose plaintext `apiKey` could not be recovered from `--projects-json`
    /// and therefore received a newly generated key.
    pub generated_project_keys: Vec<(String, String)>,
}

/// Optional legacy `projects.json` entry used to recover plaintext project keys.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyProjectJson {
    /// Project ID.
    id: String,
    /// Plaintext API key.
    #[serde(default)]
    api_key: Option<String>,
}

/// Migrates an existing v0.1.0 PostgreSQL catalog in-place inside a single transaction.
///
/// # Errors
/// Returns an error if `LINGUIST_CATALOG_KEY` mismatches, any script fails compilation,
/// or a database operation fails (rolling back all changes cleanly).
#[allow(clippy::too_many_lines)]
pub async fn run_migrate_v02(
    pool: &PgPool,
    secrets: &CatalogSecrets,
    engine: &ScriptEngine,
    projects_json_path: Option<&Path>,
) -> Result<MigrationReport> {
    let already_v2: bool = sqlx::query_scalar(
        "SELECT EXISTS (\
            SELECT 1 FROM information_schema.columns \
            WHERE table_schema = 'public' AND table_name = 'catalog_state' AND column_name = 'schema_version'\
        )",
    )
    .fetch_one(pool)
    .await?;

    if already_v2 {
        return Ok(MigrationReport {
            already_migrated: true,
            providers: 0,
            provider_models: 0,
            projects: 0,
            project_models: 0,
            routes: 0,
            generated_project_keys: Vec::new(),
        });
    }

    let legacy_keys = load_legacy_project_keys(projects_json_path)?;
    let mut tx = pool.begin().await?;

    let (old_rev, old_key_tag, billing_prices, billing_fx_rates) =
        sqlx::query_as::<_, (i64, Option<Vec<u8>>, Option<Value>, Option<Value>)>(
            "SELECT revision, key_tag, billing_prices, billing_fx_rates \
             FROM catalog_state WHERE singleton FOR UPDATE",
        )
        .fetch_one(&mut *tx)
        .await?;

    let our_tag = secrets.key_tag();
    if let Some(tag) = old_key_tag.as_deref() {
        ensure!(
            tag == our_tag.as_slice(),
            "LINGUIST_CATALOG_KEY does not match the v0.1.0 PostgreSQL catalog"
        );
    }

    let old_providers = sqlx::query_as::<_, OldProviderRow>(
        "SELECT id, position, name, icon, encrypted_key, script FROM catalog_providers ORDER BY position",
    )
    .fetch_all(&mut *tx)
    .await?;

    let old_models = sqlx::query_as::<_, OldModelRow>(
        "SELECT provider_id, id, position, name, icon, url, supports_reasoning_effort, \
                tool_calling, vision, thinking, streaming, max_input_tokens, max_output_tokens, script \
         FROM catalog_provider_models ORDER BY provider_id, position",
    )
    .fetch_all(&mut *tx)
    .await?;

    let old_projects = sqlx::query_as::<_, OldProjectRow>(
        "SELECT id, position, name, icon, key_digest, meta, script FROM catalog_projects ORDER BY position",
    )
    .fetch_all(&mut *tx)
    .await?;

    let old_call_models = sqlx::query_as::<_, OldProjectModelRow>(
        "SELECT project_id, id, position, name, icon, meta, script FROM catalog_project_models ORDER BY project_id, position",
    )
    .fetch_all(&mut *tx)
    .await?;

    let old_routes = sqlx::query_as::<_, OldRouteRow>(
        "SELECT id, position, name, enabled, priority, project_ids, call_model_ids, \
                allow_patterns, deny_patterns, rewrite_response_model, script \
         FROM catalog_route_rules ORDER BY priority DESC, position ASC",
    )
    .fetch_all(&mut *tx)
    .await?;

    let old_targets = sqlx::query_as::<_, OldTargetRow>(
        "SELECT route_id, position, provider_id, model_id, max_attempts \
         FROM catalog_route_targets ORDER BY route_id, position ASC",
    )
    .fetch_all(&mut *tx)
    .await?;

    // Index billing_prices by (providerId, modelId).
    let mut price_map: HashMap<(String, String), Value> = HashMap::new();
    if let Some(Value::Array(arr)) = billing_prices {
        for item in arr {
            if let (Some(pid), Some(mid)) = (
                item.get("providerId").and_then(Value::as_str),
                item.get("modelId").and_then(Value::as_str),
            ) {
                price_map.insert((pid.to_string(), mid.to_string()), item);
            }
        }
    }

    // Index route targets.
    let mut targets_by_route: HashMap<String, Vec<OldTargetRow>> = HashMap::new();
    for t in old_targets {
        targets_by_route
            .entry(t.route_id.clone())
            .or_default()
            .push(t);
    }

    // Transpile & compile all 5 dimensions in memory before altering tables.
    let mut new_providers = Vec::with_capacity(old_providers.len());
    for p in old_providers {
        let scripts = match p.script {
            Some(code) if !code.trim().is_empty() => vec![ScriptItem {
                id: "outbound".to_string(),
                name: "出站适配脚本".to_string(),
                enabled: true,
                code: wrap_legacy_on_request(&rewrite_v1_script_refs(&code)),
            }],
            _ => Vec::new(),
        };
        let compiled = engine
            .compile_chain(&scripts)
            .with_context(|| format!("failed to compile migrated provider '{}' scripts", p.id))?;
        new_providers.push((
            p.id,
            p.position,
            p.name,
            p.icon,
            p.encrypted_key,
            scripts,
            compiled,
        ));
    }

    let mut new_models = Vec::with_capacity(old_models.len());
    for m in old_models {
        let mut scripts = Vec::new();
        let decl_code = build_model_declaration_script(&m);
        scripts.push(ScriptItem {
            id: "decl".to_string(),
            name: "端点与能力声明".to_string(),
            enabled: true,
            code: decl_code,
        });
        if let Some(code) = m.script
            && !code.trim().is_empty()
        {
            scripts.push(ScriptItem {
                id: "outbound".to_string(),
                name: "出站参数适配".to_string(),
                enabled: true,
                code: wrap_legacy_on_request(&rewrite_v1_script_refs(&code)),
            });
        }
        if let Some(price_val) = price_map.get(&(m.provider_id.clone(), m.id.clone())) {
            let price_json = serde_json::to_string_pretty(price_val)?;
            scripts.push(ScriptItem {
                id: "billing".to_string(),
                name: "分档计费策略".to_string(),
                enabled: true,
                code: format!(
                    "export function onBilling(b: BillingContext): void {{\n  linguist.tierBilling(b, {price_json});\n}}"
                ),
            });
        }
        let compiled = engine.compile_chain(&scripts).with_context(|| {
            format!(
                "failed to compile migrated model '{}/{}' scripts",
                m.provider_id, m.id
            )
        })?;
        new_models.push((
            m.provider_id,
            m.id,
            m.position,
            m.name,
            m.icon,
            scripts,
            compiled,
        ));
    }

    let mut generated_project_keys = Vec::new();
    let mut new_projects = Vec::with_capacity(old_projects.len());
    for proj in old_projects {
        let recovered = legacy_keys
            .get(&proj.id)
            .filter(|candidate| {
                secrets.digest_project(&proj.id, candidate).as_slice() == proj.key_digest.as_slice()
            })
            .cloned();

        let api_key = if let Some(key) = recovered {
            key
        } else {
            let generated = generate_project_key()?;
            generated_project_keys.push((proj.id.clone(), generated.clone()));
            generated
        };

        let scripts = build_meta_and_request_scripts(&proj.meta.0, proj.script.as_deref());
        let compiled = engine
            .compile_chain(&scripts)
            .with_context(|| format!("failed to compile migrated project '{}' scripts", proj.id))?;
        new_projects.push((
            proj.id,
            proj.position,
            proj.name,
            proj.icon,
            api_key,
            scripts,
            compiled,
        ));
    }

    let mut new_call_models = Vec::with_capacity(old_call_models.len());
    for cm in old_call_models {
        let scripts = build_meta_and_request_scripts(&cm.meta.0, cm.script.as_deref());
        let compiled = engine.compile_chain(&scripts).with_context(|| {
            format!(
                "failed to compile migrated callModel '{}/{}' scripts",
                cm.project_id, cm.id
            )
        })?;
        new_call_models.push((
            cm.project_id,
            cm.id,
            cm.position,
            cm.name,
            cm.icon,
            scripts,
            compiled,
        ));
    }

    let mut new_routes = Vec::with_capacity(old_routes.len());
    for (idx, r) in old_routes.into_iter().enumerate() {
        let targets = targets_by_route.remove(&r.id).unwrap_or_default();
        let code = build_migrated_route_script(&r, &targets)?;
        let scripts = vec![ScriptItem {
            id: "route".to_string(),
            name: "路由匹配与选路规则".to_string(),
            enabled: true,
            code,
        }];
        let compiled = engine
            .compile_chain(&scripts)
            .with_context(|| format!("failed to compile migrated route '{}' script", r.id))?;
        let new_pos = i64::try_from(idx).unwrap_or(0);
        new_routes.push((
            r.id,
            new_pos,
            r.name,
            "openrouter".to_string(),
            r.enabled,
            scripts,
            compiled,
        ));
    }

    // Drop v0.1.0 tables and create clean v0.2.0 tables inside the same transaction.
    for stmt in [
        "DROP TABLE IF EXISTS catalog_route_targets",
        "DROP TABLE IF EXISTS catalog_route_rules",
        "DROP TABLE IF EXISTS catalog_project_models",
        "DROP TABLE IF EXISTS catalog_projects",
        "DROP TABLE IF EXISTS catalog_provider_models",
        "DROP TABLE IF EXISTS catalog_providers",
        "DROP TABLE IF EXISTS catalog_state",
        "CREATE TABLE catalog_state (
            singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
            schema_version INTEGER NOT NULL DEFAULT 2 CHECK (schema_version = 2),
            revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
            key_tag BYTEA CHECK (octet_length(key_tag) = 32),
            billing_fx_rates JSONB,
            updated_at TIMESTAMPTZ
        )",
        "CREATE TABLE catalog_providers (
            id TEXT PRIMARY KEY CHECK (btrim(id) <> ''),
            position BIGINT NOT NULL UNIQUE CHECK (position >= 0),
            name TEXT NOT NULL,
            icon TEXT NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            encrypted_key BYTEA,
            scripts JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(scripts) = 'array'),
            derived_tags TEXT[] NOT NULL DEFAULT '{}'::text[],
            derived_meta JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(derived_meta) = 'object'),
            derived_hooks TEXT[] NOT NULL DEFAULT '{}'::text[],
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )",
        "CREATE TABLE catalog_provider_models (
            provider_id TEXT NOT NULL REFERENCES catalog_providers(id) ON DELETE RESTRICT,
            id TEXT NOT NULL CHECK (btrim(id) <> ''),
            position BIGINT NOT NULL CHECK (position >= 0),
            name TEXT NOT NULL,
            icon TEXT NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            scripts JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(scripts) = 'array'),
            derived_tags TEXT[] NOT NULL DEFAULT '{}'::text[],
            derived_meta JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(derived_meta) = 'object'),
            derived_hooks TEXT[] NOT NULL DEFAULT '{}'::text[],
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (provider_id, id),
            UNIQUE (provider_id, position)
        )",
        "CREATE TABLE catalog_projects (
            id TEXT PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]+$'),
            position BIGINT NOT NULL UNIQUE CHECK (position >= 0),
            name TEXT NOT NULL,
            icon TEXT NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            api_key TEXT NOT NULL CHECK (btrim(api_key) <> ''),
            scripts JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(scripts) = 'array'),
            derived_tags TEXT[] NOT NULL DEFAULT '{}'::text[],
            derived_meta JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(derived_meta) = 'object'),
            derived_hooks TEXT[] NOT NULL DEFAULT '{}'::text[],
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )",
        "CREATE TABLE catalog_project_models (
            project_id TEXT NOT NULL REFERENCES catalog_projects(id) ON DELETE RESTRICT,
            id TEXT NOT NULL CHECK (btrim(id) NOT IN ('', '*')),
            position BIGINT NOT NULL CHECK (position >= 0),
            name TEXT NOT NULL,
            icon TEXT NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            scripts JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(scripts) = 'array'),
            derived_tags TEXT[] NOT NULL DEFAULT '{}'::text[],
            derived_meta JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(derived_meta) = 'object'),
            derived_hooks TEXT[] NOT NULL DEFAULT '{}'::text[],
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (project_id, id),
            UNIQUE (project_id, position)
        )",
        "CREATE TABLE catalog_route_rules (
            id TEXT PRIMARY KEY CHECK (btrim(id) <> ''),
            position BIGINT NOT NULL UNIQUE CHECK (position >= 0),
            name TEXT NOT NULL,
            icon TEXT NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            scripts JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(scripts) = 'array'),
            derived_tags TEXT[] NOT NULL DEFAULT '{}'::text[],
            derived_meta JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(derived_meta) = 'object'),
            derived_hooks TEXT[] NOT NULL DEFAULT '{}'::text[],
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )",
    ] {
        sqlx::query(stmt).execute(&mut *tx).await?;
    }

    sqlx::query(
        "INSERT INTO catalog_state (singleton, schema_version, revision, key_tag, billing_fx_rates, updated_at) \
         VALUES (TRUE, 2, $1, $2, $3, NOW())",
    )
    .bind(old_rev.max(1))
    .bind(our_tag.as_slice())
    .bind(billing_fx_rates)
    .execute(&mut *tx)
    .await?;

    let prov_count = new_providers.len();
    for (id, pos, name, icon, enc_key, scripts, comp) in new_providers {
        sqlx::query(
            "INSERT INTO catalog_providers \
             (id, position, name, icon, enabled, encrypted_key, scripts, derived_tags, derived_meta, derived_hooks, updated_at) \
             VALUES ($1, $2, $3, $4, TRUE, $5, $6, $7, $8, $9, NOW())",
        )
        .bind(id)
        .bind(pos)
        .bind(name)
        .bind(icon)
        .bind(enc_key)
        .bind(Json(scripts))
        .bind(comp.tags)
        .bind(Json(comp.meta))
        .bind(comp.hooks)
        .execute(&mut *tx)
        .await?;
    }

    let model_count = new_models.len();
    for (pid, id, pos, name, icon, scripts, comp) in new_models {
        sqlx::query(
            "INSERT INTO catalog_provider_models \
             (provider_id, id, position, name, icon, enabled, scripts, derived_tags, derived_meta, derived_hooks, updated_at) \
             VALUES ($1, $2, $3, $4, $5, TRUE, $6, $7, $8, $9, NOW())",
        )
        .bind(pid)
        .bind(id)
        .bind(pos)
        .bind(name)
        .bind(icon)
        .bind(Json(scripts))
        .bind(comp.tags)
        .bind(Json(comp.meta))
        .bind(comp.hooks)
        .execute(&mut *tx)
        .await?;
    }

    let project_count = new_projects.len();
    for (id, pos, name, icon, api_key, scripts, comp) in new_projects {
        sqlx::query(
            "INSERT INTO catalog_projects \
             (id, position, name, icon, enabled, api_key, scripts, derived_tags, derived_meta, derived_hooks, updated_at) \
             VALUES ($1, $2, $3, $4, TRUE, $5, $6, $7, $8, $9, NOW())",
        )
        .bind(id)
        .bind(pos)
        .bind(name)
        .bind(icon)
        .bind(api_key)
        .bind(Json(scripts))
        .bind(comp.tags)
        .bind(Json(comp.meta))
        .bind(comp.hooks)
        .execute(&mut *tx)
        .await?;
    }

    let cm_count = new_call_models.len();
    for (pid, id, pos, name, icon, scripts, comp) in new_call_models {
        sqlx::query(
            "INSERT INTO catalog_project_models \
             (project_id, id, position, name, icon, enabled, scripts, derived_tags, derived_meta, derived_hooks, updated_at) \
             VALUES ($1, $2, $3, $4, $5, TRUE, $6, $7, $8, $9, NOW())",
        )
        .bind(pid)
        .bind(id)
        .bind(pos)
        .bind(name)
        .bind(icon)
        .bind(Json(scripts))
        .bind(comp.tags)
        .bind(Json(comp.meta))
        .bind(comp.hooks)
        .execute(&mut *tx)
        .await?;
    }

    let route_count = new_routes.len();
    for (id, pos, name, icon, enabled, scripts, comp) in new_routes {
        sqlx::query(
            "INSERT INTO catalog_route_rules \
             (id, position, name, icon, enabled, scripts, derived_tags, derived_meta, derived_hooks, updated_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())",
        )
        .bind(id)
        .bind(pos)
        .bind(name)
        .bind(icon)
        .bind(enabled)
        .bind(Json(scripts))
        .bind(comp.tags)
        .bind(Json(comp.meta))
        .bind(comp.hooks)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    Ok(MigrationReport {
        already_migrated: false,
        providers: prov_count,
        provider_models: model_count,
        projects: project_count,
        project_models: cm_count,
        routes: route_count,
        generated_project_keys,
    })
}

/// Reads optional `projects.json` to recover plaintext `apiKey` values.
fn load_legacy_project_keys(path: Option<&Path>) -> Result<HashMap<String, String>> {
    let mut map = HashMap::new();
    let Some(path) = path else {
        return Ok(map);
    };
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("failed to read legacy projects.json at {}", path.display()))?;
    let val: Value = serde_json::from_str(&raw)?;
    let arr = if let Some(items) = val.get("items").and_then(Value::as_array) {
        items.clone()
    } else if let Some(items) = val.as_array() {
        items.clone()
    } else {
        Vec::new()
    };
    for item in arr {
        if let Ok(proj) = serde_json::from_value::<LegacyProjectJson>(item)
            && let Some(key) = proj.api_key.filter(|s| !s.trim().is_empty())
        {
            map.insert(proj.id, key);
        }
    }
    Ok(map)
}

/// Generates a secure random `lin-proj-<24hex>` key when a project's key cannot be recovered.
fn generate_project_key() -> Result<String> {
    let mut buf = [0u8; 12];
    SystemRandom::new()
        .fill(&mut buf)
        .map_err(|_| anyhow::anyhow!("random key generation failed"))?;
    let mut out = String::from("lin-proj-");
    for b in buf {
        use std::fmt::Write as _;
        let _ = write!(out, "{b:02x}");
    }
    Ok(out)
}

/// Builds `export const tags` and `export const meta` for a migrated `ProviderModel`.
fn build_model_declaration_script(m: &OldModelRow) -> String {
    let mut tags = Vec::new();
    if m.tool_calling == Some(true) {
        tags.push("tools");
    }
    if m.vision == Some(true) {
        tags.push("vision");
    }
    if m.thinking == Some(true) {
        tags.push("thinking");
    }
    if m.streaming == Some(true) {
        tags.push("streaming");
    }

    let mut meta = Map::new();
    meta.insert("url".to_string(), Value::String(m.url.clone()));
    if let Some(efforts) = &m.supports_reasoning_effort {
        meta.insert("supportsReasoningEffort".to_string(), json!(efforts));
    }
    if let Some(v) = m.max_input_tokens {
        meta.insert("maxInputTokens".to_string(), json!(v));
    }
    if let Some(v) = m.max_output_tokens {
        meta.insert("maxOutputTokens".to_string(), json!(v));
    }

    let tags_json = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".to_string());
    let meta_json =
        serde_json::to_string_pretty(&Value::Object(meta)).unwrap_or_else(|_| "{}".to_string());

    format!("export const tags = {tags_json};\nexport const meta = {meta_json};")
}

/// Builds `[decl/outbound]` scripts for a migrated `Project` or `CallModel`.
fn build_meta_and_request_scripts(
    meta: &Map<String, Value>,
    old_script: Option<&str>,
) -> Vec<ScriptItem> {
    let mut parts = Vec::new();
    if !meta.is_empty() {
        let meta_json = serde_json::to_string_pretty(&Value::Object(meta.clone()))
            .unwrap_or_else(|_| "{}".to_string());
        parts.push(format!("export const meta = {meta_json};"));
    }
    if let Some(code) = old_script
        && !code.trim().is_empty()
    {
        parts.push(wrap_legacy_on_request(&rewrite_v1_script_refs(code)));
    }
    if parts.is_empty() {
        Vec::new()
    } else {
        vec![ScriptItem {
            id: "main".to_string(),
            name: "迁移策略脚本".to_string(),
            enabled: true,
            code: parts.join("\n\n"),
        }]
    }
}

/// Converts a v0.1.0 route rule + targets into an equivalent v0.2.0 `onRequest` script.
fn build_migrated_route_script(r: &OldRouteRow, targets: &[OldTargetRow]) -> Result<String> {
    let proj_ids = serde_json::to_string(&r.project_ids)?;
    let cm_ids = serde_json::to_string(&r.call_model_ids)?;
    let allow = serde_json::to_string(&r.allow_patterns)?;
    let deny = serde_json::to_string(&r.deny_patterns)?;

    let primary = targets.first().map(|t| {
        json!({
            "providerId": t.provider_id,
            "modelId": t.model_id,
            "maxAttempts": t.max_attempts
        })
    });
    let fallbacks: Vec<Value> = targets
        .iter()
        .skip(1)
        .map(|t| {
            json!({
                "providerId": t.provider_id,
                "modelId": t.model_id,
                "maxAttempts": t.max_attempts
            })
        })
        .collect();

    let primary_js = serde_json::to_string(&primary)?;
    let fallbacks_js = serde_json::to_string(&fallbacks)?;

    let inner_script = r
        .script
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(rewrite_v1_script_refs)
        .unwrap_or_default();

    let custom_block = if inner_script.is_empty() {
        String::new()
    } else {
        format!("\n  await (async function(ctx) {{\n{inner_script}\n  }})(ctx);\n")
    };

    Ok(format!(
        r#"function __matchList(list, val) {{
  return list.includes("*") || list.includes(val);
}}
function __patMatch(pat, pid, mid) {{
  const p = String(pat).trim();
  if (p === "*") return true;
  const slash = p.indexOf("/");
  if (slash >= 0) {{
    const pp = p.slice(0, slash);
    const mp = p.slice(slash + 1);
    return (pp === "*" || pp === pid) && (mp === "*" || mp === mid);
  }}
  return p === mid || p === pid;
}}
export async function onRequest(ctx: ScriptContext): Promise<void> {{
  if (!__matchList({proj_ids}, ctx.project.id)) return;
  if (!__matchList({cm_ids}, ctx.callModel.id)) return;
  const allow = {allow};
  const deny = {deny};
  ctx.route.candidates = ctx.route.candidates.filter((c) => {{
    const ok = allow.length === 0 || allow.some((pat) => __patMatch(pat, c.provider.id, c.model.id));
    if (!ok) return false;
    return !deny.some((pat) => __patMatch(pat, c.provider.id, c.model.id));
  }});
  ctx.route.rewriteResponseModel = {rewrite};
  const defTarget = {primary_js};
  const defFallbacks = {fallbacks_js};
  if (defTarget) ctx.route.target = defTarget;
  if (defFallbacks.length > 0) ctx.route.fallbacks = defFallbacks;{custom_block}
}}"#,
        rewrite = r.rewrite_response_model
    ))
}

/// Wraps a legacy statement-style script (without `export`) into `export async function onRequest(ctx)`.
fn wrap_legacy_on_request(code: &str) -> String {
    let trimmed = code.trim();
    if trimmed.contains("export ") {
        trimmed.to_string()
    } else {
        format!(
            "export async function onRequest(ctx: ScriptContext): Promise<void> {{\n{trimmed}\n}}"
        )
    }
}

/// Rewrites v0.1.0 top-level model capability property reads to v0.2.0 `tags` / `meta` reads.
fn rewrite_v1_script_refs(code: &str) -> String {
    let mut s = code.to_string();
    for (flag, tag) in [
        ("toolCalling", "tools"),
        ("vision", "vision"),
        ("thinking", "thinking"),
        ("streaming", "streaming"),
    ] {
        for prefix in ["c.model.", "ctx.model?.", "ctx.model."] {
            let from = format!("{prefix}{flag}");
            let to = if prefix.contains("?.") {
                format!("ctx.model?.tags.includes(\"{tag}\")")
            } else {
                format!("{prefix}tags.includes(\"{tag}\")")
            };
            s = s.replace(&from, &to);
        }
    }
    for meta_key in [
        "supportsReasoningEffort",
        "maxInputTokens",
        "maxOutputTokens",
        "url",
    ] {
        for prefix in ["c.model.", "ctx.model?.", "ctx.model."] {
            let from = format!("{prefix}{meta_key}");
            let to = format!("{prefix}meta.{meta_key}");
            s = s.replace(&from, &to);
        }
    }
    s
}

/// Legacy v0.1.0 SQL row structs.
#[allow(clippy::missing_docs_in_private_items)]
#[derive(FromRow)]
struct OldProviderRow {
    id: String,
    position: i64,
    name: String,
    icon: String,
    encrypted_key: Option<Vec<u8>>,
    script: Option<String>,
}

#[allow(clippy::missing_docs_in_private_items)]
#[derive(FromRow)]
struct OldModelRow {
    provider_id: String,
    id: String,
    position: i64,
    name: String,
    icon: String,
    url: String,
    supports_reasoning_effort: Option<Vec<String>>,
    tool_calling: Option<bool>,
    vision: Option<bool>,
    thinking: Option<bool>,
    streaming: Option<bool>,
    max_input_tokens: Option<i64>,
    max_output_tokens: Option<i64>,
    script: Option<String>,
}

#[allow(clippy::missing_docs_in_private_items)]
#[derive(FromRow)]
struct OldProjectRow {
    id: String,
    position: i64,
    name: String,
    icon: String,
    key_digest: Vec<u8>,
    meta: Json<Map<String, Value>>,
    script: Option<String>,
}

#[allow(clippy::missing_docs_in_private_items)]
#[derive(FromRow)]
struct OldProjectModelRow {
    project_id: String,
    id: String,
    position: i64,
    name: String,
    icon: String,
    meta: Json<Map<String, Value>>,
    script: Option<String>,
}

#[allow(clippy::missing_docs_in_private_items)]
#[derive(FromRow)]
struct OldRouteRow {
    id: String,
    #[allow(dead_code)]
    position: i64,
    name: String,
    enabled: bool,
    #[allow(dead_code)]
    priority: i32,
    project_ids: Vec<String>,
    call_model_ids: Vec<String>,
    allow_patterns: Vec<String>,
    deny_patterns: Vec<String>,
    rewrite_response_model: bool,
    script: Option<String>,
}

#[allow(clippy::missing_docs_in_private_items)]
#[derive(FromRow)]
struct OldTargetRow {
    route_id: String,
    #[allow(dead_code)]
    position: i64,
    provider_id: String,
    model_id: String,
    max_attempts: i16,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_legacy_model_capability_and_meta_fields() {
        let legacy = "if (!c.model.vision || !ctx.model?.toolCalling) return; const lim = ctx.model.maxOutputTokens;";
        let rewritten = rewrite_v1_script_refs(legacy);
        assert!(rewritten.contains("c.model.tags.includes(\"vision\")"));
        assert!(rewritten.contains("ctx.model?.tags.includes(\"tools\")"));
        assert!(rewritten.contains("ctx.model.meta.maxOutputTokens"));
    }
}
