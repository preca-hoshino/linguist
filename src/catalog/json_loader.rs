//! JSON file implementation of `CatalogProvider`, atomic persistence, and file change detection.

use std::collections::{BTreeMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, ensure};
use async_trait::async_trait;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio::sync::mpsc;
use tracing::warn;
use uuid::Uuid;

use super::{CatalogProvider, RuntimeCatalog, validation};
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
        self.load_snapshot().map(|(catalog, _)| catalog)
    }

    /// Reads all inputs and verifies that none changed while assembling the snapshot.
    pub(super) fn load_snapshot(&self) -> Result<(RuntimeCatalog, FileReads)> {
        let mut files = FileReads::default();
        let providers = load_providers(
            &self.configs.providers_path,
            &self.script_engine,
            &mut files,
        )?;
        let projects = load_projects(&self.configs.projects_path, &self.script_engine, &mut files)?;
        let routes = load_routes(&self.configs.routes_path, &self.script_engine, &mut files)?;
        let catalog = RuntimeCatalog::new(providers, projects, routes);
        validation::validate(&catalog)?;
        ensure!(
            files.unchanged(),
            "catalog files changed during the read; retrying on next check"
        );
        Ok((catalog, files))
    }

    /// Watches the main JSON directories for atomic replacements; external scripts are polled.
    pub(super) fn watch_files(&self, tx: mpsc::Sender<()>) -> Result<RecommendedWatcher> {
        let paths = [
            self.configs.providers_path.clone(),
            self.configs.projects_path.clone(),
            self.configs.routes_path.clone(),
        ];
        let names: HashSet<_> = paths
            .iter()
            .filter_map(|p| p.file_name().map(ToOwned::to_owned))
            .collect();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res
                && matches!(
                    event.kind,
                    EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
                )
                && event
                    .paths
                    .iter()
                    .any(|p| p.file_name().is_some_and(|name| names.contains(name)))
            {
                let _ = tx.try_send(());
            }
        })
        .context("failed to initialize JSON file watcher")?;
        let dirs: HashSet<_> = paths.iter().map(|p| parent_dir_of(p)).collect();
        for parent in dirs {
            watcher
                .watch(parent, RecursiveMode::NonRecursive)
                .with_context(|| format!("failed to watch directory {}", parent.display()))?;
        }
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

/// Exact bytes read from the documents and all resolved script dependencies.
#[derive(Default)]
pub(super) struct FileReads(BTreeMap<PathBuf, Vec<u8>>);

impl FileReads {
    /// Reads each path once within a candidate snapshot.
    fn read(&mut self, path: &Path) -> Result<&[u8]> {
        use std::collections::btree_map::Entry;
        let bytes = match self.0.entry(path.to_owned()) {
            Entry::Occupied(entry) => entry.into_mut(),
            Entry::Vacant(entry) => entry.insert(
                fs::read(path).with_context(|| format!("failed to read {}", path.display()))?,
            ),
        };
        Ok(bytes)
    }

    /// Detects edits, deletion, and atomic replacement, even with unchanged metadata.
    pub(super) fn unchanged(&self) -> bool {
        self.0
            .iter()
            .all(|(path, bytes)| fs::read(path).is_ok_and(|fresh| &fresh == bytes))
    }
}

/// Parses and validates supply-side `chatLanguageModels.json`, skipping non-`customendpoint`
/// or non-`chat-completions` groups cleanly.
fn load_providers(
    path: &Path,
    engine: &ScriptEngine,
    files: &mut FileReads,
) -> Result<Vec<ProviderConfig>> {
    let (_schema_ver, raw_list) = load_versioned_json::<RawProviderConfig>(path, files)?;
    let base_dir = parent_dir_of(path);
    let raw_list: Vec<_> = raw_list
        .into_iter()
        .filter(|raw| {
            raw.vendor
                .as_deref()
                .is_none_or(|vendor| vendor == "customendpoint")
                && raw
                    .api_type
                    .as_deref()
                    .is_none_or(|api_type| api_type == "chat-completions")
        })
        .collect();
    let mut ids = vec![String::new(); raw_list.len()];
    let mut seen_ids = HashSet::new();
    let entries = raw_list.iter().enumerate();
    // Allocate legacy IDs first; providers without models never reserved an ID before.
    for (index, raw) in entries
        .clone()
        .filter(|(_, raw)| !raw.models.is_empty())
        .chain(entries.filter(|(_, raw)| raw.models.is_empty()))
    {
        let base = raw
            .id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map_or_else(|| derive_provider_slug(&raw.name), str::to_string);
        let mut id = base.clone();
        let mut suffix = 2;
        while !seen_ids.insert(id.clone()) {
            id = format!("{base}-{suffix}");
            suffix += 1;
        }
        ids[index] = id;
    }

    let mut providers = Vec::with_capacity(raw_list.len());
    for (raw, pid) in raw_list.into_iter().zip(ids) {
        let p_icon = raw
            .icon
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| infer_provider_icon(&pid, &raw.name));

        let p_script = resolve_and_validate_script(
            raw.script.as_ref(),
            base_dir,
            engine,
            files,
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
                files,
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
            vendor: raw.vendor,
            api_type: raw.api_type,
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
fn load_projects(
    path: &Path,
    engine: &ScriptEngine,
    files: &mut FileReads,
) -> Result<Vec<ProjectConfig>> {
    let (_schema_ver, raw_list) = load_versioned_json::<RawProjectConfig>(path, files)?;
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
            files,
            &format!("project '{}'", raw.id),
        )?;

        let mut call_models = Vec::with_capacity(raw.call_models.len());
        for rcm in raw.call_models {
            if rcm.id.trim().is_empty() || rcm.id.trim() == "*" {
                return Err(anyhow!(
                    "project '{}' has an invalid callModel id '{}': wildcard or empty ids are not \
                     allowed, declare every callModel explicitly",
                    raw.id,
                    rcm.id
                ));
            }
            let cm_icon = rcm
                .icon
                .clone()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| infer_model_icon(&rcm.id, &rcm.name, &p_icon));

            let cm_script = resolve_and_validate_script(
                rcm.script.as_ref(),
                base_dir,
                engine,
                files,
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
fn load_routes(
    path: &Path,
    engine: &ScriptEngine,
    files: &mut FileReads,
) -> Result<Vec<RouteRuleConfig>> {
    let (_schema_ver, raw_list) = load_versioned_json::<RawRouteRuleConfig>(path, files)?;
    let base_dir = parent_dir_of(path);
    let mut routes = Vec::with_capacity(raw_list.len());

    for raw in raw_list {
        let r_script = resolve_and_validate_script(
            raw.script.as_ref(),
            base_dir,
            engine,
            files,
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
fn load_versioned_json<T: DeserializeOwned>(
    path: &Path,
    files: &mut FileReads,
) -> Result<(u32, Vec<T>)> {
    let parsed: VersionedList<T> = serde_json::from_slice(files.read(path)?)
        .with_context(|| format!("invalid JSON schema in {}", path.display()))?;
    Ok(parsed.into_items())
}

/// Resolves an optional `ScriptSource` (`string`, `string[]`, or `@file:`) and compiles it
/// to catch syntax errors before swapping into runtime state.
fn resolve_and_validate_script(
    source: Option<&ScriptSource>,
    base_dir: &Path,
    engine: &ScriptEngine,
    files: &mut FileReads,
    label: &str,
) -> Result<Option<String>> {
    let Some(src) = source else {
        return Ok(None);
    };
    let resolved = match src {
        ScriptSource::Single(text) => {
            if let Some(path) = text.trim().strip_prefix("@file:") {
                let path = base_dir.join(path.trim());
                std::str::from_utf8(files.read(&path)?)
                    .with_context(|| format!("non-UTF-8 script for {label}"))?
                    .to_owned()
            } else {
                text.clone()
            }
        }
        ScriptSource::Lines(lines) => lines.join("\n"),
    };
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
                r#"[{"id":"default","name":"Default","apiKey":"k-default","callModels":[{"id":"deepseek-v4-pro","name":"Passthrough"}]}]"#,
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
    fn preserves_legacy_provider_ids_when_importing_empty_providers() {
        let path = std::env::temp_dir().join(format!("linguist-providers-{}.json", Uuid::new_v4()));
        let fixture = r#"[
            {"name":"Repeat","models":[]},
            {"name":"Repeat","models":[{"id":"a","name":"A","url":"https://example.test"}]},
            {"name":"Other","id":"repeat","models":[{"id":"b","name":"B","url":"https://example.test"}]}
        ]"#;
        assert!(fs::write(&path, fixture).is_ok());
        let engine = ScriptEngine::new(ScriptEngineConfig::default());
        let providers = load_providers(&path, &engine, &mut FileReads::default());
        let _ = fs::remove_file(path);

        let ids = providers
            .unwrap_or_default()
            .into_iter()
            .map(|provider| provider.id)
            .collect::<Vec<_>>();
        assert_eq!(ids, ["repeat-3", "repeat", "repeat-2"]);
    }

    #[test]
    fn rejects_projects_without_api_key_or_with_unsafe_id() {
        let dir = std::env::temp_dir().join(format!("linguist-projects-{}", std::process::id()));
        assert!(fs::create_dir_all(&dir).is_ok());
        let engine = ScriptEngine::new(ScriptEngineConfig::default());
        let load = |name: &str, json: &str| {
            let path = dir.join(name);
            assert!(fs::write(&path, json).is_ok());
            load_projects(&path, &engine, &mut FileReads::default())
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

        let wildcard = load(
            "wildcard.json",
            r#"[{"id":"a","name":"A","apiKey":"k","callModels":[{"id":"*","name":"Any"}]}]"#,
        );
        assert!(wildcard.is_err_and(|e| e.to_string().contains("callModel")));

        let ok = load(
            "ok.json",
            r#"[{"id":"team-1_a","name":"A","apiKey":"k","callModels":[]}]"#,
        );
        assert!(ok.is_ok());

        let _ = fs::remove_dir_all(&dir);
    }
}
