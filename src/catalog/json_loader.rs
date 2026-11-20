//! JSON file implementation of `CatalogProvider`, atomic persistence, and `notify` hot-reload.

use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use arc_swap::ArcSwap;
use async_trait::async_trait;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use serde::de::DeserializeOwned;
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::catalog::{CatalogProvider, RuntimeCatalog};
use crate::config::ConfigsSection;
use crate::models::{
    CallModelConfig, ModelConfig, ProjectConfig, ProviderConfig, RawProjectConfig,
    RawProviderConfig, RawRouteRuleConfig, RouteRuleConfig, ScriptSource, VersionedList,
    derive_provider_slug, infer_model_icon, infer_provider_icon,
};
use crate::script_engine::ScriptEngine;

/// `CatalogProvider` backed by `chatLanguageModels.json`, `projects.json`, and `routes.json`.
#[derive(Debug, Clone)]
pub struct JsonFileCatalogProvider {
    /// Path configuration.
    configs: ConfigsSection,
    /// Script engine used to pre-validate all 5 script stages during load.
    script_engine: ScriptEngine,
}

impl JsonFileCatalogProvider {
    /// Creates a new `JsonFileCatalogProvider`.
    #[must_use]
    pub const fn new(configs: ConfigsSection, script_engine: ScriptEngine) -> Self {
        Self {
            configs,
            script_engine,
        }
    }

    /// Loads and validates the catalog synchronously from disk.
    ///
    /// # Errors
    /// Returns an error if any file cannot be read, parsed, or contains an invalid script.
    pub fn load_sync(&self) -> Result<RuntimeCatalog> {
        let providers = load_providers(&self.configs.providers_path, &self.script_engine)?;
        let projects = load_projects(&self.configs.projects_path, &self.script_engine)?;
        let routes = load_routes(&self.configs.routes_path, &self.script_engine)?;
        Ok(RuntimeCatalog::new(providers, projects, routes))
    }

    /// Spawns a background file watcher (`notify`) that reloads and atomically swaps
    /// `ArcSwap<RuntimeCatalog>` whenever any of the 3 JSON files changes.
    ///
    /// # Errors
    /// Returns an error if the OS file watcher cannot be created or registered.
    pub fn spawn_watcher(
        &self,
        catalog_swap: Arc<ArcSwap<RuntimeCatalog>>,
    ) -> Result<RecommendedWatcher> {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<()>(16);
        let watched_names: Vec<String> = [
            &self.configs.providers_path,
            &self.configs.projects_path,
            &self.configs.routes_path,
        ]
        .iter()
        .filter_map(|p| p.file_name().and_then(|n| n.to_str()).map(str::to_string))
        .collect();

        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                let is_relevant = matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_))
                    && event.paths.iter().any(|p| {
                        p.file_name()
                            .and_then(|n| n.to_str())
                            .is_some_and(|name| watched_names.iter().any(|w| w == name))
                    });
                if is_relevant {
                    let _ = tx.try_send(());
                }
            }
        })
        .context("failed to initialize JSON file watcher")?;

        let mut dirs: HashSet<PathBuf> = HashSet::new();
        for path in [
            &self.configs.providers_path,
            &self.configs.projects_path,
            &self.configs.routes_path,
        ] {
            let parent = path
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or_else(|| Path::new("."));
            if dirs.insert(parent.to_path_buf()) {
                watcher
                    .watch(parent, RecursiveMode::NonRecursive)
                    .with_context(|| format!("failed to watch directory {}", parent.display()))?;
            }
        }

        let loader = self.clone();
        tokio::spawn(async move {
            while rx.recv().await.is_some() {
                // Coalesce burst editor write/rename events.
                tokio::time::sleep(Duration::from_millis(120)).await;
                while rx.try_recv().is_ok() {}

                match loader.load_sync() {
                    Ok(new_catalog) => {
                        let providers = new_catalog.providers.len();
                        let models = new_catalog.total_models();
                        let projects = new_catalog.projects.len();
                        let routes = new_catalog.routes.len();
                        catalog_swap.store(Arc::new(new_catalog));
                        info!(
                            providers,
                            models, projects, routes, "hot-reloaded Linguist JSON catalog"
                        );
                    }
                    Err(err) => {
                        error!(
                            error = %err,
                            "hot-reload rejected invalid catalog update; keeping previous snapshot"
                        );
                    }
                }
            }
        });

        Ok(watcher)
    }
}

#[async_trait]
impl CatalogProvider for JsonFileCatalogProvider {
    async fn load_catalog(&self) -> Result<RuntimeCatalog> {
        let loader = self.clone();
        tokio::task::spawn_blocking(move || loader.load_sync())
            .await
            .context("catalog loader task panicked")?
    }
}

/// Parses and validates supply-side `chatLanguageModels.json`, skipping non-`customendpoint`
/// or non-`chat-completions` groups cleanly.
fn load_providers(path: &Path, engine: &ScriptEngine) -> Result<Vec<ProviderConfig>> {
    let (_schema_ver, raw_list) = load_versioned_json::<RawProviderConfig>(path)?;
    let base_dir = parent_dir_of(path);
    let mut providers = Vec::new();
    let mut seen_ids = HashSet::new();

    for raw in raw_list {
        if let Some(vendor) = raw.vendor.as_deref()
            && vendor != "customendpoint"
        {
            continue;
        }
        if let Some(api_type) = raw.api_type.as_deref()
            && api_type != "chat-completions"
        {
            continue;
        }
        if raw.models.is_empty() {
            continue;
        }

        let mut pid = raw
            .id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map_or_else(|| derive_provider_slug(&raw.name), str::to_string);

        if !seen_ids.insert(pid.clone()) {
            let mut suffix = 2usize;
            while !seen_ids.insert(format!("{pid}-{suffix}")) {
                suffix += 1;
            }
            pid = format!("{pid}-{suffix}");
        }

        let p_icon = raw
            .icon
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| infer_provider_icon(&pid, &raw.name));

        let p_script = resolve_and_validate_script(
            raw.script.as_ref(),
            base_dir,
            engine,
            &format!("provider '{pid}'"),
        )?;

        let mut models = Vec::with_capacity(raw.models.len());
        for rm in raw.models {
            let m_icon = rm
                .icon
                .clone()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| infer_model_icon(&rm.id, &rm.name, &p_icon));

            let m_script = resolve_and_validate_script(
                rm.script.as_ref(),
                base_dir,
                engine,
                &format!("model '{pid}/{}'", rm.id),
            )?;

            models.push(ModelConfig {
                id: rm.id,
                name: rm.name,
                icon: m_icon,
                url: rm.url,
                supports_reasoning_effort: rm.supports_reasoning_effort,
                tool_calling: rm.tool_calling,
                vision: rm.vision,
                thinking: rm.thinking,
                streaming: rm.streaming,
                max_input_tokens: rm.max_input_tokens,
                max_output_tokens: rm.max_output_tokens,
                script: m_script,
            });
        }

        providers.push(ProviderConfig {
            id: pid,
            name: raw.name,
            icon: p_icon,
            api_key: raw.api_key,
            script: p_script,
            models,
        });
    }

    Ok(providers)
}

/// Parses and validates consume-side `projects.json`.
fn load_projects(path: &Path, engine: &ScriptEngine) -> Result<Vec<ProjectConfig>> {
    let (_schema_ver, raw_list) = load_versioned_json::<RawProjectConfig>(path)?;
    let base_dir = parent_dir_of(path);
    let mut projects = Vec::with_capacity(raw_list.len());

    for raw in raw_list {
        if raw.id.is_empty()
            || !raw
                .id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return Err(anyhow!(
                "project id '{}' is invalid: only ASCII letters, digits, '_' and '-' are allowed \
                 because it is used in the /model/{{project_id}}/v1 endpoint path",
                raw.id
            ));
        }
        let Some(api_key) = raw.api_key.clone().filter(|s| !s.trim().is_empty()) else {
            return Err(anyhow!(
                "project '{}' must define a non-empty apiKey (required by /model/{}/v1)",
                raw.id,
                raw.id
            ));
        };

        let p_icon = raw
            .icon
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "copilot-color".to_string());

        let p_script = resolve_and_validate_script(
            raw.script.as_ref(),
            base_dir,
            engine,
            &format!("project '{}'", raw.id),
        )?;

        let mut call_models = Vec::with_capacity(raw.call_models.len());
        for rcm in raw.call_models {
            let cm_icon = rcm
                .icon
                .clone()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| infer_model_icon(&rcm.id, &rcm.name, &p_icon));

            let cm_script = resolve_and_validate_script(
                rcm.script.as_ref(),
                base_dir,
                engine,
                &format!("callModel '{}/{}'", raw.id, rcm.id),
            )?;

            call_models.push(CallModelConfig {
                id: rcm.id,
                name: rcm.name,
                icon: cm_icon,
                meta: rcm.meta,
                script: cm_script,
            });
        }

        projects.push(ProjectConfig {
            id: raw.id,
            name: raw.name,
            api_key: Some(api_key),
            icon: p_icon,
            meta: raw.meta,
            script: p_script,
            call_models,
        });
    }

    Ok(projects)
}

/// Parses and validates `routes.json`.
fn load_routes(path: &Path, engine: &ScriptEngine) -> Result<Vec<RouteRuleConfig>> {
    let (_schema_ver, raw_list) = load_versioned_json::<RawRouteRuleConfig>(path)?;
    let base_dir = parent_dir_of(path);
    let mut routes = Vec::with_capacity(raw_list.len());

    for raw in raw_list {
        let r_script = resolve_and_validate_script(
            raw.script.as_ref(),
            base_dir,
            engine,
            &format!("route '{}'", raw.id),
        )?;

        if raw.enabled && r_script.is_none() && raw.target.is_none() {
            warn!(
                route_id = %raw.id,
                "route rule has neither 'script' nor static 'target'"
            );
        }

        routes.push(RouteRuleConfig {
            id: raw.id,
            name: raw.name,
            enabled: raw.enabled,
            priority: raw.priority,
            match_rule: raw.match_rule,
            candidates: raw.candidates,
            target: raw.target,
            fallbacks: raw.fallbacks,
            rewrite_response_model: raw.rewrite_response_model,
            script: r_script,
        });
    }

    Ok(routes)
}

/// Reads a JSON list supporting both legacy bare arrays (`v1`) and `{ "schemaVersion", "items" }`.
fn load_versioned_json<T: DeserializeOwned>(path: &Path) -> Result<(u32, Vec<T>)> {
    let bytes = fs::read(path)
        .with_context(|| format!("failed to read catalog JSON {}", path.display()))?;
    let parsed: VersionedList<T> = serde_json::from_slice(&bytes)
        .with_context(|| format!("invalid JSON schema in {}", path.display()))?;
    Ok(parsed.into_items())
}

/// Resolves an optional `ScriptSource` (`string`, `string[]`, or `@file:`) and compiles it
/// to catch syntax errors before swapping into runtime state.
fn resolve_and_validate_script(
    source: Option<&ScriptSource>,
    base_dir: &Path,
    engine: &ScriptEngine,
    label: &str,
) -> Result<Option<String>> {
    let Some(src) = source else {
        return Ok(None);
    };
    let resolved = src
        .resolve(base_dir)
        .with_context(|| format!("failed to resolve script for {label}"))?;
    if resolved.trim().is_empty() {
        return Ok(None);
    }
    engine
        .validate_script(&resolved)
        .with_context(|| format!("failed to compile script for {label}"))?;
    Ok(Some(resolved))
}

/// Returns the parent directory of `path` or `"."`.
fn parent_dir_of(path: &Path) -> &Path {
    path.parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
}

/// Atomically writes `bytes` to `path` via temp file + `sync_all` + `rename`
/// (with `0o600` permissions on Unix), preserving existing data on any failure.
///
/// # Errors
/// Returns an error if creating, syncing, or renaming the temporary file fails.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| anyhow!("invalid target path for atomic write: {}", path.display()))?;
    let temp = path.with_file_name(format!("{file_name}.{}.tmp", Uuid::new_v4().simple()));

    let write_res = (|| -> Result<()> {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temp)
            .with_context(|| format!("create temp file {}", temp.display()))?;
        file.write_all(bytes)
            .with_context(|| format!("write temp file {}", temp.display()))?;
        file.sync_all()
            .with_context(|| format!("sync temp file {}", temp.display()))?;
        drop(file);
        fs::rename(&temp, path).with_context(|| {
            format!("replace target file {}; original preserved", path.display())
        })?;
        Ok(())
    })();

    if write_res.is_err() {
        let _ = fs::remove_file(&temp);
    }
    write_res
}

/// Backs up and atomically migrates a JSON config file using `transform` after validating
/// the transformed output, never altering the original file if anything fails.
///
/// # Errors
/// Returns an error if reading, transforming, validating, backing up, or writing fails.
pub fn load_and_migrate_file<Raw, New, F, V>(
    path: &Path,
    old_version_tag: &str,
    transform: F,
    validate: V,
) -> Result<New>
where
    Raw: DeserializeOwned,
    New: Serialize,
    F: FnOnce(Raw) -> Result<(bool, New)>,
    V: FnOnce(&New) -> Result<()>,
{
    let raw_bytes =
        fs::read(path).with_context(|| format!("read config file {}", path.display()))?;
    let parsed: Raw = serde_json::from_slice(&raw_bytes)
        .with_context(|| format!("parse config file {}; original preserved", path.display()))?;

    let (needs_migration, migrated) = transform(parsed)?;
    validate(&migrated)?;

    if needs_migration {
        let backup_name = format!(
            "{}.{old_version_tag}.bak",
            path.file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("config.json")
        );
        let backup_path = path.with_file_name(backup_name);
        if !backup_path.exists() {
            fs::write(&backup_path, &raw_bytes)
                .with_context(|| format!("write backup file {}", backup_path.display()))?;
        }
        let encoded = serde_json::to_vec_pretty(&migrated)
            .context("serialize migrated config; original preserved")?;
        write_atomic(path, &encoded)?;
    }

    Ok(migrated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ScriptEngineConfig;

    #[test]
    fn loads_desktop_providers_projects_and_routes_when_available() {
        let temp_dir = std::env::temp_dir().join(format!("linguist-test-{}", Uuid::new_v4()));
        assert!(fs::create_dir_all(&temp_dir).is_ok());

        let providers_path = temp_dir.join("providers.json");
        let projects_path = temp_dir.join("projects.json");
        let routes_path = temp_dir.join("routes.json");
        let ext_script = temp_dir.join("inject.ts");

        assert!(fs::write(&ext_script, "ctx.request.headers['x-ext'] = 'yes';").is_ok());
        assert!(
            fs::write(
                &providers_path,
                r#"[
                  {"name":"Copilot","vendor":"copilot","settings":{}},
                  {"name":"OProxy","vendor":"customendpoint","apiType":"messages","models":[{"id":"claude","name":"Claude","url":"https://x"}]},
                  {"name":"深度求索","vendor":"customendpoint","apiType":"chat-completions","apiKey":"sk-123","script":"@file:./inject.ts","models":[{"id":"deepseek-v4-pro","name":"DeepSeek V4 Pro","url":"https://api.deepseek.com","toolCalling":true}]}
                ]"#,
            )
            .is_ok()
        );
        assert!(
            fs::write(
                &projects_path,
                r#"[{"id":"default","name":"Default","apiKey":"k-default","callModels":[{"id":"*","name":"Passthrough"}]}]"#,
            )
            .is_ok()
        );
        assert!(
            fs::write(
                &routes_path,
                r#"[{"id":"r1","name":"R1","enabled":true,"priority":10,"match":{"projectIds":["*"],"callModelIds":["*"]},"target":{"providerId":"deepseek","modelId":"deepseek-v4-pro"}}]"#,
            )
            .is_ok()
        );

        let loader = JsonFileCatalogProvider::new(
            ConfigsSection {
                source: "json_files".to_string(),
                providers_path,
                projects_path,
                routes_path,
                watch_reload: false,
            },
            ScriptEngine::new(ScriptEngineConfig::default()),
        );

        let catalog = loader.load_sync();
        assert!(catalog.is_ok(), "catalog load failed: {catalog:?}");
        if let Ok(cat) = catalog {
            assert_eq!(cat.providers.len(), 1);
            assert_eq!(cat.providers[0].id, "deepseek");
            assert_eq!(
                cat.providers[0].script.as_deref(),
                Some("ctx.request.headers['x-ext'] = 'yes';")
            );
        }

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn rejects_projects_without_api_key_or_with_unsafe_id() {
        let dir = std::env::temp_dir().join(format!("linguist-projects-{}", std::process::id()));
        assert!(fs::create_dir_all(&dir).is_ok());
        let engine = ScriptEngine::new(ScriptEngineConfig::default());
        let load = |name: &str, json: &str| {
            let path = dir.join(name);
            assert!(fs::write(&path, json).is_ok());
            load_projects(&path, &engine)
        };

        let no_key = load("no_key.json", r#"[{"id":"a","name":"A","callModels":[]}]"#);
        assert!(no_key.is_err_and(|e| e.to_string().contains("apiKey")));

        let blank_key = load(
            "blank_key.json",
            r#"[{"id":"a","name":"A","apiKey":"  ","callModels":[]}]"#,
        );
        assert!(blank_key.is_err());

        let bad_id = load(
            "bad_id.json",
            r#"[{"id":"a/b","name":"A","apiKey":"k","callModels":[]}]"#,
        );
        assert!(bad_id.is_err_and(|e| e.to_string().contains("invalid")));

        let ok = load(
            "ok.json",
            r#"[{"id":"team-1_a","name":"A","apiKey":"k","callModels":[]}]"#,
        );
        assert!(ok.is_ok());

        let _ = fs::remove_dir_all(&dir);
    }
}
