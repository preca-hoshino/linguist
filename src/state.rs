//! Shared application state passed across Axum proxy and telemetry handlers.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use arc_swap::ArcSwap;
use sqlx::PgPool;

use crate::catalog::RuntimeCatalog;
use crate::config::AppConfig;
use crate::db::LogWriterHandle;
use crate::metrics_cache::MetricsCache;
use crate::models::RequestLogRecord;
use crate::script_engine::ScriptEngine;

/// Thread-safe shared state for Linguist HTTP handlers.
#[derive(Debug, Clone)]
pub struct AppState {
    /// Loaded TOML configuration.
    pub config: AppConfig,
    /// Lock-free hot-swappable configuration catalog.
    pub catalog: Arc<ArcSwap<RuntimeCatalog>>,
    /// Sliding window metrics cache for Stage ③ candidate selection.
    pub metrics: MetricsCache,
    /// Sandboxed TS/JS script engine.
    pub engine: ScriptEngine,
    /// Pooled upstream HTTP client.
    pub http_client: reqwest::Client,
    /// Optional PostgreSQL pool (used by stats API and `/healthz`).
    pub db_pool: Option<PgPool>,
    /// Optional async log writer handle.
    pub log_writer: Option<LogWriterHandle>,
    /// Hash of the console token; project keys do not grant console access.
    catalog_token: Option<ring::digest::Digest>,
}

impl AppState {
    /// Constructs a new `AppState` with a tuned pooled `reqwest::Client`.
    ///
    /// # Errors
    /// Returns an error if the HTTP client fails to initialize.
    pub fn new(
        config: AppConfig,
        catalog: Arc<ArcSwap<RuntimeCatalog>>,
        metrics: MetricsCache,
        engine: ScriptEngine,
        db_pool: Option<PgPool>,
        log_writer: Option<LogWriterHandle>,
    ) -> Result<Self> {
        let timeout = Duration::from_secs(config.server.upstream_timeout_secs.max(5));
        let http_client = reqwest::Client::builder()
            .connect_timeout(timeout)
            .read_timeout(timeout)
            .pool_max_idle_per_host(64)
            .build()
            .context("failed to build upstream reqwest HTTP client")?;

        Ok(Self {
            config,
            catalog,
            metrics,
            engine,
            http_client,
            db_pool,
            log_writer,
            catalog_token: None,
        })
    }

    /// Enables the configuration console with a separate operator bearer token.
    #[must_use]
    pub fn with_catalog_token(mut self, token: Option<&str>) -> Self {
        self.catalog_token = token
            .filter(|token| !token.is_empty())
            .map(|token| ring::digest::digest(&ring::digest::SHA256, token.as_bytes()));
        self
    }

    /// Checks a console token, or returns `None` if console access is not configured.
    pub(crate) fn verify_catalog_token(&self, token: &str) -> Option<bool> {
        self.catalog_token.as_ref().map(|expected| {
            let provided = ring::digest::digest(&ring::digest::SHA256, token.as_bytes());
            crate::catalog::secrets::tokens_equal(expected.as_ref(), provided.as_ref())
        })
    }

    /// Emits a finalized telemetry record to PostgreSQL if DB logging is active.
    pub fn emit_log(&self, record: RequestLogRecord) {
        if let Some(writer) = &self.log_writer {
            writer.send(record);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{MetricsConfig, ScriptEngineConfig};

    #[test]
    fn app_state_initializes_http_client_with_system_and_webpki_roots() {
        let state = AppState::new(
            AppConfig::default(),
            Arc::new(ArcSwap::from_pointee(RuntimeCatalog::default())),
            MetricsCache::new(&MetricsConfig::default()),
            ScriptEngine::new(ScriptEngineConfig::default()),
            None,
            None,
        );
        assert!(state.is_ok());
    }
}
