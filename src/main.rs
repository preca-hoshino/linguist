//! Linguist CLI entrypoint (`serve`, `check-config`, `seed-demo`).

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use arc_swap::ArcSwap;
use clap::{Parser, Subcommand};
use serde_json::json;
use tokio::net::TcpListener;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

use linguist::catalog::CatalogProvider;
use linguist::catalog::json_loader::JsonFileCatalogProvider;
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
    /// Validate `config.toml`, JSON catalogs, and compile all 5-stage TS/JS scripts offline.
    CheckConfig,
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
            let engine = ScriptEngine::new(cfg.script_engine.clone());
            let loader = JsonFileCatalogProvider::new(cfg.configs.clone(), engine);
            let catalog = loader.load_sync()?;

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
        Commands::SeedDemo { days } => {
            let engine = ScriptEngine::new(cfg.script_engine.clone());
            let loader = JsonFileCatalogProvider::new(cfg.configs.clone(), engine);
            let catalog = loader.load_sync()?;
            let pool = db::init_db_pool(&cfg.database).await?;
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

/// Boots the PostgreSQL pool, catalog loader, hot-reload watcher, metrics cache,
/// and Axum HTTP server.
async fn run_serve(cfg: AppConfig) -> Result<()> {
    let engine = ScriptEngine::new(cfg.script_engine.clone());
    let loader = JsonFileCatalogProvider::new(cfg.configs.clone(), engine.clone());
    let initial_catalog = loader.load_catalog().await?;

    info!(
        providers = initial_catalog.providers.len(),
        models = initial_catalog.total_models(),
        projects = initial_catalog.projects.len(),
        routes = initial_catalog.routes.len(),
        "loaded Linguist JSON catalog"
    );

    let catalog_swap = Arc::new(ArcSwap::from_pointee(initial_catalog));
    let _watcher = if cfg.configs.watch_reload {
        match loader.spawn_watcher(Arc::clone(&catalog_swap)) {
            Ok(w) => {
                info!("JSON catalog file hot-reload watcher enabled");
                Some(w)
            }
            Err(err) => {
                warn!(error = %err, "failed to start hot-reload watcher; continuing without watch");
                None
            }
        }
    } else {
        None
    };

    let pool = db::init_db_pool(&cfg.database).await?;
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
    )?;

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
