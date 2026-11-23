//! Configuration structures and loader for `config.toml`.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// Top-level Linguist application configuration loaded from `config.toml`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct AppConfig {
    /// HTTP server settings.
    pub server: ServerConfig,
    /// PostgreSQL logging and telemetry settings.
    pub database: DatabaseConfig,
    /// Catalog configuration source settings.
    pub configs: ConfigsSection,
    /// Script engine sandbox limits and retry status codes.
    pub script_engine: ScriptEngineConfig,
    /// In-memory sliding window speed cache settings.
    pub metrics: MetricsConfig,
    /// Read-only dashboard presentation settings.
    pub ui: UiConfig,
    /// Optional expense display settings.
    pub billing: BillingConfig,
}

/// Optional display currency for cost reports; accounting always uses the price currency.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct BillingConfig {
    /// Three-letter currency code; absent means original currencies only.
    pub display_currency: Option<String>,
}

/// HTTP server bind and upstream timeout settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ServerConfig {
    /// Bind host address.
    pub host: String,
    /// Bind TCP port.
    pub port: u16,
    /// Upstream connection/read inactivity timeout; also the total deadline for non-streaming requests.
    pub upstream_timeout_secs: u64,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            host: "127.0.0.1".to_string(),
            port: 9527,
            upstream_timeout_secs: 600,
        }
    }
}

/// PostgreSQL connection and telemetry settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct DatabaseConfig {
    /// PostgreSQL connection string.
    pub url: String,
    /// Maximum connection pool size.
    pub max_connections: u32,
    /// Whether to persist request/response payloads when upstream fails (status >= 400).
    pub log_error_payload: bool,
    /// Whether to persist full payloads for all requests.
    pub log_full_payload: bool,
}

impl Default for DatabaseConfig {
    fn default() -> Self {
        Self {
            url: "postgres://linguist:password@127.0.0.1:5432/linguist".to_string(),
            max_connections: 10,
            log_error_payload: true,
            log_full_payload: false,
        }
    }
}

/// Catalog ingestion configuration. The runtime always reads PostgreSQL.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ConfigsSection {
    /// `json_sync` imports files into PostgreSQL; `postgres` only consumes it.
    pub source: String,
    /// Path to supply-side `chatLanguageModels.json`.
    pub providers_path: PathBuf,
    /// Path to consume-side `projects.json`.
    pub projects_path: PathBuf,
    /// Path to `routes.json`.
    pub routes_path: PathBuf,
    /// Whether to watch JSON files for live hot-reload.
    pub watch_reload: bool,
}

impl ConfigsSection {
    /// Resolves the ingest mode; `json_files` remains an alias for older deployments.
    ///
    /// # Errors
    /// Returns an error for an unknown configuration source.
    pub fn imports_json(&self) -> Result<bool> {
        match self.source.as_str() {
            "json_sync" | "json_files" => Ok(true),
            "postgres" => Ok(false),
            _ => anyhow::bail!("[configs].source must be json_sync or postgres"),
        }
    }
}

impl Default for ConfigsSection {
    fn default() -> Self {
        Self {
            source: "json_sync".to_string(),
            providers_path: PathBuf::from("./chatLanguageModels.json"),
            projects_path: PathBuf::from("./projects.json"),
            routes_path: PathBuf::from("./routes.json"),
            watch_reload: true,
        }
    }
}

/// TS/JS script sandbox constraints and automatic fallback triggers.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ScriptEngineConfig {
    /// Maximum execution time per script invocation in milliseconds.
    pub timeout_ms: u64,
    /// Maximum buffer/memory limit in megabytes.
    pub memory_limit_mb: u64,
    /// HTTP status codes before first byte that trigger fallback retry.
    pub fallback_status_codes: Vec<u16>,
}

impl Default for ScriptEngineConfig {
    fn default() -> Self {
        Self {
            timeout_ms: 50,
            memory_limit_mb: 32,
            fallback_status_codes: vec![429, 500, 502, 503, 504],
        }
    }
}

/// Real-time sliding window metrics configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct MetricsConfig {
    /// Sliding window length in minutes.
    pub sliding_window_minutes: u64,
    /// Days of historical logs to warm up on startup from PostgreSQL.
    pub warmup_days_from_db: u32,
}

impl Default for MetricsConfig {
    fn default() -> Self {
        Self {
            sliding_window_minutes: 60,
            warmup_days_from_db: 7,
        }
    }
}

/// Frontend presentation preferences.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct UiConfig {
    /// Browser and header title.
    pub title: String,
    /// Display timezone identifier.
    pub timezone: String,
    /// Default chart range in days.
    pub default_days_range: u32,
    /// Minimum sample count required to show on leaderboard.
    pub leaderboard_min_requests: u64,
}

impl Default for UiConfig {
    fn default() -> Self {
        Self {
            title: "Linguist Gateway & Telemetry".to_string(),
            timezone: "Asia/Shanghai".to_string(),
            default_days_range: 30,
            leaderboard_min_requests: 1,
        }
    }
}

impl AppConfig {
    /// Loads configuration from `config_path` and resolves relative asset paths
    /// relative to the directory containing `config_path`.
    ///
    /// # Errors
    /// Returns an error if the file cannot be read or contains invalid TOML.
    pub fn load_from_path(config_path: &Path) -> Result<Self> {
        let raw = fs::read_to_string(config_path)
            .with_context(|| format!("failed to read config file {}", config_path.display()))?;
        let mut config: Self = toml::from_str(&raw)
            .with_context(|| format!("failed to parse TOML config {}", config_path.display()))?;

        let base_dir = config_path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));

        config.configs.providers_path = resolve_relative(base_dir, &config.configs.providers_path);
        config.configs.projects_path = resolve_relative(base_dir, &config.configs.projects_path);
        config.configs.routes_path = resolve_relative(base_dir, &config.configs.routes_path);

        Ok(config)
    }
}

/// Resolves a relative path against `base_dir` while preserving absolute paths.
fn resolve_relative(base_dir: &Path, path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        base_dir.join(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_roundtrip() {
        let toml_str = toml::to_string(&AppConfig::default()).ok();
        assert!(toml_str.is_some());
        let parsed: Result<AppConfig, _> = toml::from_str(toml_str.as_deref().unwrap_or(""));
        assert!(parsed.is_ok());
    }

    #[test]
    fn legacy_icons_section_is_ignored() {
        let raw = r#"
[server]
host = "0.0.0.0"
port = 9527

[icons]
lobe_icons_dir = "./icons/lobe"
custom_icons_dir = "./icons/custom"
"#;
        let parsed: Result<AppConfig, _> = toml::from_str(raw);
        assert!(parsed.is_ok());
    }
}
