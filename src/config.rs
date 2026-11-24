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
    /// OIDC authentication settings for the admin console and telemetry dashboard.
    pub oidc: OidcConfig,
}

/// OIDC provider and client settings for admin authentication.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct OidcConfig {
    /// OIDC issuer URL (must match the discovery document `issuer`).
    pub issuer: String,
    /// OAuth2/OIDC client ID registered with the identity provider.
    pub client_id: String,
    /// External callback URL registered with the identity provider.
    pub redirect_uri: String,
    /// Path to the file containing only the OIDC client secret.
    pub client_secret_file: PathBuf,
}

/// Validated OIDC runtime configuration required by `serve`.
#[derive(Clone)]
pub struct ValidatedOidcConfig {
    /// Normalized issuer URL (trimmed of trailing whitespace).
    pub issuer: String,
    /// OAuth2/OIDC client ID.
    pub client_id: String,
    /// External callback URL.
    pub redirect_uri: String,
    /// Whether the redirect URI uses HTTPS (controls `Secure` cookie attribute).
    pub secure_cookies: bool,
    /// OIDC client secret loaded from `client_secret_file`.
    pub client_secret: String,
    /// Exact OIDC `sub` allowed to hold an admin session.
    pub admin_sub: String,
}

impl std::fmt::Debug for ValidatedOidcConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ValidatedOidcConfig")
            .field("issuer", &self.issuer)
            .field("client_id", &self.client_id)
            .field("redirect_uri", &self.redirect_uri)
            .field("secure_cookies", &self.secure_cookies)
            .field("client_secret", &"[REDACTED]")
            .field("admin_sub", &self.admin_sub)
            .finish()
    }
}

impl OidcConfig {
    /// Validates OIDC configuration fields, reads `client_secret_file`, and requires
    /// `LINGUIST_OIDC_ADMIN_SUB` for `serve`.
    ///
    /// # Errors
    /// Returns an error when any required OIDC parameter, secret file, or admin `sub`
    /// is missing or invalid.
    pub fn validate_for_serve(&self, admin_sub: Option<&str>) -> Result<ValidatedOidcConfig> {
        let issuer = self.issuer.trim().to_string();
        if issuer.is_empty() {
            anyhow::bail!("[oidc].issuer must be configured");
        }
        let issuer_url = reqwest::Url::parse(&issuer)
            .with_context(|| format!("invalid [oidc].issuer URL '{issuer}'"))?;
        validate_oidc_url(&issuer_url, "[oidc].issuer")?;

        let client_id = self.client_id.trim().to_string();
        if client_id.is_empty() {
            anyhow::bail!("[oidc].client_id must be configured");
        }

        let redirect_uri = self.redirect_uri.trim().to_string();
        if redirect_uri.is_empty() {
            anyhow::bail!("[oidc].redirect_uri must be configured");
        }
        let parsed_redirect = reqwest::Url::parse(&redirect_uri)
            .with_context(|| format!("invalid [oidc].redirect_uri URL '{redirect_uri}'"))?;
        validate_oidc_url(&parsed_redirect, "[oidc].redirect_uri")?;
        let secure_cookies = parsed_redirect.scheme() == "https";

        if self.client_secret_file.as_os_str().is_empty() {
            anyhow::bail!("[oidc].client_secret_file must be configured");
        }
        let secret_raw = fs::read_to_string(&self.client_secret_file).with_context(|| {
            format!(
                "failed to read [oidc].client_secret_file at {}",
                self.client_secret_file.display()
            )
        })?;
        let client_secret = secret_raw.trim().to_string();
        if client_secret.is_empty() {
            anyhow::bail!(
                "[oidc].client_secret_file {} is empty",
                self.client_secret_file.display()
            );
        }

        let admin_sub = admin_sub
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .context("LINGUIST_OIDC_ADMIN_SUB environment variable must be set")?
            .to_string();

        Ok(ValidatedOidcConfig {
            issuer,
            client_id,
            redirect_uri,
            secure_cookies,
            client_secret,
            admin_sub,
        })
    }
}

/// Ensures an OIDC URL uses HTTPS, allowing HTTP only for loopback development hosts.
fn validate_oidc_url(url: &reqwest::Url, field: &str) -> Result<()> {
    match url.scheme() {
        "https" => Ok(()),
        "http" => {
            let is_loopback = matches!(
                url.host_str(),
                Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
            );
            if is_loopback {
                Ok(())
            } else {
                anyhow::bail!("{field} must use https:// outside local loopback development");
            }
        }
        other => anyhow::bail!("{field} has unsupported URL scheme '{other}'"),
    }
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
        if !config.oidc.client_secret_file.as_os_str().is_empty() {
            config.oidc.client_secret_file =
                resolve_relative(base_dir, &config.oidc.client_secret_file);
        }

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

    #[test]
    fn oidc_validation_requires_all_fields_and_https_in_prod() {
        let dir = std::env::temp_dir().join(format!("linguist-oidc-cfg-{}", uuid::Uuid::new_v4()));
        assert!(fs::create_dir(&dir).is_ok());
        let secret_path = dir.join("secret");
        assert!(fs::write(&secret_path, "super-secret\n").is_ok());

        let mut cfg = OidcConfig {
            issuer: "https://pass.restart.org.cn/oidc".to_string(),
            client_id: "cid".to_string(),
            redirect_uri: "https://linguist.example.com/auth/callback".to_string(),
            client_secret_file: secret_path.clone(),
        };

        assert!(cfg.validate_for_serve(None).is_err());
        assert!(cfg.validate_for_serve(Some("  ")).is_err());

        let ok = cfg.validate_for_serve(Some("admin-sub-1"));
        assert!(ok.is_ok());
        if let Ok(validated) = ok {
            assert_eq!(validated.client_secret, "super-secret");
            assert!(validated.secure_cookies);
        }

        cfg.redirect_uri = "http://linguist.example.com/auth/callback".to_string();
        assert!(cfg.validate_for_serve(Some("admin-sub-1")).is_err());

        cfg.redirect_uri = "http://localhost:5173/auth/callback".to_string();
        let dev_ok = cfg.validate_for_serve(Some("admin-sub-1"));
        assert!(dev_ok.is_ok());
        if let Ok(validated) = dev_ok {
            assert!(!validated.secure_cookies);
        }

        let _ = fs::remove_dir_all(&dir);
    }
}
