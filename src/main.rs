//! Linguist CLI entrypoint (`serve`, `check-config`, `dry-run`, `seed-demo`).

use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use serde_json::{Map, Value, json};
use tokio::net::TcpListener;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;
use uuid::Uuid;

use linguist::auth::oidc::OidcClient;
use linguist::catalog::postgres::PgCatalogProvider;
use linguist::catalog::secrets::CatalogSecrets;
use linguist::catalog::{CatalogProvider, RuntimeCatalog, sync};
use linguist::config::AppConfig;
use linguist::db::{self, LogWriterHandle};
use linguist::metrics_cache::MetricsCache;
use linguist::script_engine::ScriptEngine;
use linguist::script_engine::pipeline::{
    StageOutcome, prepare_attempt_context, run_routing_stages,
};
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
    /// Validate the PostgreSQL catalog and compile all five script chains.
    CheckConfig,
    /// Dry-run the 5-stage routing & request script pipeline without sending upstream HTTP requests.
    DryRun {
        /// Project ID to simulate.
        #[arg(long)]
        project_id: String,
        /// Requested model ID.
        #[arg(long)]
        model: String,
        /// Simulate `stream: true`.
        #[arg(long, default_value_t = false)]
        stream: bool,
    },
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
            let script_count = count_catalog_scripts(&catalog);
            println!(
                "Config OK: source=postgres, providers={}, models={}, projects={}, routes={}, compiled_scripts={}",
                catalog.providers.len(),
                catalog.total_models(),
                catalog.projects.len(),
                catalog.routes.len(),
                script_count
            );
        }
        Commands::DryRun {
            project_id,
            model,
            stream,
        } => {
            run_dry_run(&cfg, &project_id, &model, stream).await?;
        }
        Commands::SeedDemo { days } => {
            let secrets = CatalogSecrets::from_env()?;
            let pool = db::init_db_pool(&cfg.database).await?;
            let engine = ScriptEngine::new(cfg.script_engine.clone());
            let provider = PgCatalogProvider::new(pool.clone(), secrets, engine.clone());
            provider.seed_demo_catalog_if_empty().await?;
            let catalog = provider.load_catalog().await?;
            let tz_offset = db::timezone_offset_secs(&cfg.ui.timezone);
            let inserted = db::seed_demo(&pool, &catalog, &engine, tz_offset, days).await?;
            println!("Seeded {inserted} demo requests across {days} days into PostgreSQL");
        }
        Commands::Serve => {
            run_serve(cfg).await?;
        }
    }

    Ok(())
}

/// Counts total script units across all 5 catalog dimensions.
fn count_catalog_scripts(catalog: &RuntimeCatalog) -> usize {
    let mut count = 0usize;
    for p in &catalog.providers {
        count += p.scripts.len();
        for m in &p.models {
            count += m.scripts.len();
        }
    }
    for proj in &catalog.projects {
        count += proj.scripts.len();
        for cm in &proj.call_models {
            count += cm.scripts.len();
        }
    }
    for r in &catalog.routes {
        count += r.scripts.len();
    }
    count
}

/// Executes a dry-run of Stages ①..⑤ against the PostgreSQL catalog.
async fn run_dry_run(cfg: &AppConfig, project_id: &str, model: &str, stream: bool) -> Result<()> {
    let engine = ScriptEngine::new(cfg.script_engine.clone());
    let catalog = load_for_cli(cfg, None).await?;
    let metrics = MetricsCache::new(&cfg.metrics);
    let mut body = Map::new();
    body.insert("model".to_string(), Value::String(model.to_string()));
    body.insert("stream".to_string(), Value::Bool(stream));
    body.insert(
        "messages".to_string(),
        json!([{ "role": "user", "content": "dry-run" }]),
    );

    let outcome = run_routing_stages(
        &catalog,
        &metrics,
        &engine,
        Uuid::new_v4(),
        project_id,
        model,
        body,
    )
    .await?;

    match outcome {
        StageOutcome::Rejected(rej) => {
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({
                    "status": "rejected",
                    "statusCode": rej.status_code,
                    "message": rej.message,
                }))?
            );
        }
        StageOutcome::Ready(plan) => {
            let mut candidates = Vec::new();
            for (idx, ep) in plan.endpoints.iter().enumerate() {
                let Some((prov, pm)) = catalog.find_model(&ep.provider_id, &ep.model_id) else {
                    candidates.push(json!({
                        "providerId": ep.provider_id,
                        "modelId": ep.model_id,
                        "status": "missing_in_catalog"
                    }));
                    continue;
                };
                let attempt = u16::try_from(idx + 1).unwrap_or(u16::MAX);
                match prepare_attempt_context(&plan.snapshot_ctx, attempt, prov, pm, &engine).await
                {
                    Ok(StageOutcome::Ready(ctx)) => candidates.push(json!({
                        "providerId": ep.provider_id,
                        "modelId": ep.model_id,
                        "status": "ready",
                        "url": ctx.request.url,
                        "body": ctx.request.body,
                        "state": ctx.state,
                    })),
                    Ok(StageOutcome::Rejected(rej)) => candidates.push(json!({
                        "providerId": ep.provider_id,
                        "modelId": ep.model_id,
                        "status": "rejected",
                        "statusCode": rej.status_code,
                        "message": rej.message,
                    })),
                    Err(err) => candidates.push(json!({
                        "providerId": ep.provider_id,
                        "modelId": ep.model_id,
                        "status": "error",
                        "error": err.to_string(),
                    })),
                }
            }
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({
                    "status": "ready",
                    "routeRuleId": plan.snapshot_ctx.route.rule_id,
                    "candidates": candidates,
                }))?
            );
        }
    }
    Ok(())
}

/// Loads the committed PostgreSQL catalog for CLI commands.
async fn load_for_cli(cfg: &AppConfig, pool: Option<sqlx::PgPool>) -> Result<RuntimeCatalog> {
    let engine = ScriptEngine::new(cfg.script_engine.clone());
    let secrets = CatalogSecrets::from_env()?;
    let pool = match pool {
        Some(pool) => pool,
        None => db::init_db_pool(&cfg.database).await?,
    };
    PgCatalogProvider::new(pool, secrets, engine)
        .load_catalog()
        .await
}

/// Starts PostgreSQL-backed configuration, telemetry, and the HTTP gateway.
async fn run_serve(cfg: AppConfig) -> Result<()> {
    let secrets = CatalogSecrets::from_env()?;
    let admin_sub = std::env::var("LINGUIST_OIDC_ADMIN_SUB").ok();
    let oidc_config = cfg.oidc.validate_for_serve(admin_sub.as_deref())?;
    let oidc_client = OidcClient::new(oidc_config)?;
    let pool = db::init_db_pool(&cfg.database).await?;
    let engine = ScriptEngine::new(cfg.script_engine.clone());
    let catalog_swap = sync::start(PgCatalogProvider::new(
        pool.clone(),
        secrets,
        engine.clone(),
    ))
    .await?;
    let metrics = MetricsCache::new(&cfg.metrics);
    match db::warmup_metrics_cache(&pool, &metrics, cfg.metrics.warmup_days_from_db).await {
        Ok(samples) => info!(samples, "warmed up MetricsCache from PostgreSQL"),
        Err(err) => warn!(error = %err, "failed to warm up MetricsCache from PostgreSQL"),
    }

    let tz_offset = db::timezone_offset_secs(&cfg.ui.timezone);
    let log_writer = LogWriterHandle::spawn(
        pool.clone(),
        cfg.database.clone(),
        tz_offset,
        engine.clone(),
    );
    let log_writer_shutdown = log_writer.clone();

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
    linguist::runtime_metrics::start_sampler(&state);

    let app = web::build_router(state);
    let addr_str = format!("{}:{}", cfg.server.host, cfg.server.port);
    let addr: SocketAddr = addr_str
        .parse()
        .with_context(|| format!("invalid bind address '{addr_str}'"))?;
    let listener = TcpListener::bind(addr)
        .await
        .with_context(|| format!("failed to bind TCP listener on {addr}"))?;

    info!(%addr, "Linguist gateway & telemetry dashboard listening");
    let graceful_secs = cfg.server.graceful_shutdown_secs.max(1);
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("Axum HTTP server terminated unexpectedly")?;

    info!(
        timeout_secs = graceful_secs,
        "HTTP server drained; flushing telemetry log writer"
    );
    log_writer_shutdown
        .flush_and_shutdown(Duration::from_secs(graceful_secs.min(15)))
        .await;

    Ok(())
}

/// Waits for `Ctrl+C` (SIGINT) or `SIGTERM` (on Unix) to initiate graceful shutdown.
async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(err) = tokio::signal::ctrl_c().await {
            warn!(error = %err, "failed to install Ctrl+C handler");
        }
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
            }
            Err(err) => {
                warn!(error = %err, "failed to install SIGTERM handler");
                std::future::pending::<()>().await;
            }
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => info!("received Ctrl+C; draining active requests"),
        () = terminate => info!("received SIGTERM; draining active requests"),
    }
}
