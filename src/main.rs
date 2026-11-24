//! Linguist CLI entrypoint (`serve`, `check-config`, `disable-json-sync`, `seed-demo`).

use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use serde_json::json;
use tokio::net::TcpListener;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

use linguist::auth::oidc::OidcClient;
use linguist::catalog::json_loader::JsonFileCatalogProvider;
use linguist::catalog::postgres::PgCatalogProvider;
use linguist::catalog::secrets::CatalogSecrets;
use linguist::catalog::{CatalogProvider, RuntimeCatalog, sync};
use linguist::config::AppConfig;
use linguist::db::{self, LogWriterHandle};
use linguist::metrics_cache::MetricsCache;
use linguist::script_engine::ScriptEngine;
use linguist::state::AppState;
use linguist::web;

/// Command-line flags for the Linguist gateway binary.
#[derive(Debug, Parser)]
#[command(
    name = "linguist",
    version,
    about = "Linguist OpenAI Chat Gateway & Telemetry"
)]
struct Cli {
    /// Path to `config.toml` configuration file.
    #[arg(long, global = true, default_value = "config.toml")]
    config: PathBuf,

    /// Subcommand to execute (defaults to `serve`).
    #[command(subcommand)]
    command: Option<Commands>,
}

/// Supported Linguist subcommands.
#[derive(Debug, Subcommand)]
enum Commands {
    /// Start the HTTP proxy gateway and embedded telemetry web dashboard.
    Serve,
    /// Validate the configured catalog and compile all five script stages.
    CheckConfig,
    /// Permanently stop JSON imports into this PostgreSQL database.
    DisableJsonSync,
    /// Initialize PostgreSQL schema and populate realistic multi-day demo telemetry.
    SeedDemo {
        /// Number of historical days to generate.
        #[arg(long, default_value_t = 180)]
        days: u32,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("linguist=info,tower_http=info"));
    tracing_subscriber::fmt().with_env_filter(filter).init();

    let cli = Cli::parse();
    let cfg = AppConfig::load_from_path(&cli.config)?;

    match cli.command.unwrap_or(Commands::Serve) {
        Commands::CheckConfig => {
            let catalog = load_for_cli(&cfg, None).await?;

            let mut script_count = 0usize;
            for p in &catalog.providers {
                if p.script.is_some() {
                    script_count += 1;
                }
                for m in &p.models {
                    if m.script.is_some() {
                        script_count += 1;
                    }
                }
            }
            for proj in &catalog.projects {
                if proj.script.is_some() {
                    script_count += 1;
                }
                for cm in &proj.call_models {
                    if cm.script.is_some() {
                        script_count += 1;
                    }
                }
            }
            for r in &catalog.routes {
                if r.script.is_some() {
                    script_count += 1;
                }
            }

            println!(
                "Config OK: source={}, providers={}, models={}, projects={}, routes={}, compiled_scripts={}",
                cfg.configs.source,
                catalog.providers.len(),
                catalog.total_models(),
                catalog.projects.len(),
                catalog.routes.len(),
                script_count
            );
        }
        Commands::DisableJsonSync => {
            let secrets = CatalogSecrets::from_env()?;
            let pool = db::init_db_pool(&cfg.database).await?;
            let engine = ScriptEngine::new(cfg.script_engine);
            PgCatalogProvider::new(pool, secrets, engine)
                .disable_json_sync()
                .await?;
            println!("PostgreSQL catalog no longer accepts JSON imports");
        }
        Commands::SeedDemo { days } => {
            let pool = db::init_db_pool(&cfg.database).await?;
            let catalog = load_for_cli(&cfg, Some(pool.clone())).await?;
            let tz_offset = db::timezone_offset_secs(&cfg.ui.timezone);
            let inserted = db::seed_demo(&pool, &catalog, tz_offset, days).await?;
            println!("Seeded {inserted} demo requests across {days} days into PostgreSQL");
        }
        Commands::Serve => {
            run_serve(cfg).await?;
        }
    }

    Ok(())
}

/// Uses the files for offline validation, or loads the committed PostgreSQL catalog in PG mode.
async fn load_for_cli(cfg: &AppConfig, pool: Option<sqlx::PgPool>) -> Result<RuntimeCatalog> {
    let engine = ScriptEngine::new(cfg.script_engine.clone());
    if cfg.configs.imports_json()? {
        JsonFileCatalogProvider::new(cfg.configs.clone(), engine)
            .load_catalog()
            .await
    } else {
        let secrets = CatalogSecrets::from_env()?;
        let pool = match pool {
            Some(pool) => pool,
            None => db::init_db_pool(&cfg.database).await?,
        };
        PgCatalogProvider::new(pool, secrets, engine)
            .load_catalog()
            .await
    }
}

/// Starts PostgreSQL-backed configuration, telemetry, and the HTTP gateway.
async fn run_serve(cfg: AppConfig) -> Result<()> {
    let imports_json = cfg.configs.imports_json()?;
    let secrets = CatalogSecrets::from_env()?;
    let admin_sub = std::env::var("LINGUIST_OIDC_ADMIN_SUB").ok();
    let oidc_config = cfg.oidc.validate_for_serve(admin_sub.as_deref())?;
    let oidc_client = OidcClient::new(oidc_config)?;
    let pool = db::init_db_pool(&cfg.database).await?;
    let engine = ScriptEngine::new(cfg.script_engine.clone());
    let importer = imports_json.then(|| {
        (
            JsonFileCatalogProvider::new(cfg.configs.clone(), engine.clone()),
            cfg.configs.watch_reload,
        )
    });
    let catalog_swap = sync::start(
        PgCatalogProvider::new(pool.clone(), secrets, engine.clone()),
        importer,
    )
    .await?;
    let metrics = MetricsCache::new(&cfg.metrics);
    match db::warmup_metrics_cache(&pool, &metrics, cfg.metrics.warmup_days_from_db).await {
        Ok(samples) => info!(samples, "warmed up MetricsCache from PostgreSQL"),
        Err(err) => warn!(error = %err, "failed to warm up MetricsCache from PostgreSQL"),
    }

    let tz_offset = db::timezone_offset_secs(&cfg.ui.timezone);
    let log_writer = LogWriterHandle::spawn(pool.clone(), cfg.database.clone(), tz_offset);

    db::log_system_event(
        &pool,
        "gateway_started",
        "info",
        "Linguist gateway started",
        json!({ "host": cfg.server.host, "port": cfg.server.port }),
    )
    .await;

    let state = AppState::new(
        cfg.clone(),
        catalog_swap,
        metrics,
        engine,
        Some(pool),
        Some(log_writer),
    )?
    .with_oidc(oidc_client);

    linguist::billing::fx::start(&state);

    let app = web::build_router(state);
    let addr_str = format!("{}:{}", cfg.server.host, cfg.server.port);
    let addr: SocketAddr = addr_str
        .parse()
        .with_context(|| format!("invalid bind address '{addr_str}'"))?;
    let listener = TcpListener::bind(addr)
        .await
        .with_context(|| format!("failed to bind TCP listener on {addr}"))?;

    info!(%addr, "Linguist gateway & telemetry dashboard listening");
    axum::serve(listener, app)
        .await
        .context("Axum HTTP server terminated unexpectedly")?;

    Ok(())
}
