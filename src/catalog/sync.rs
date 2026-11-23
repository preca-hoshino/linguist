//! JSON ingestion and atomic refresh from committed PostgreSQL revisions.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use arc_swap::ArcSwap;
use tokio::sync::mpsc;
use tokio::time::{self, MissedTickBehavior};
use tracing::{info, warn};

use super::json_loader::{FileReads, JsonFileCatalogProvider};
use super::postgres::PgCatalogProvider;
use super::{CatalogProvider, RuntimeCatalog};

/// Ingests the initial JSON snapshot if configured, then starts runtime refresh.
///
/// # Errors
/// Returns an error if PostgreSQL does not have a valid committed catalog.
pub async fn start(
    store: PgCatalogProvider,
    importer: Option<(JsonFileCatalogProvider, bool)>,
) -> Result<Arc<ArcSwap<RuntimeCatalog>>> {
    let importer = if importer.is_some() && !store.accepts_json().await? {
        None
    } else {
        importer
    };
    let mut previous = None;
    if let Some((loader, _)) = &importer {
        previous = check_json(&store, loader, None).await;
    }
    let initial = store
        .load_catalog()
        .await
        .context("could not load the committed PostgreSQL catalog")?;
    info!(revision = initial.revision(), "loaded PostgreSQL catalog");
    let active = Arc::new(ArcSwap::from_pointee(initial));
    tokio::spawn(refresh_runtime(store.clone(), Arc::clone(&active)));
    if let Some((loader, true)) = importer {
        tokio::spawn(watch_json(store, loader, previous));
    }
    Ok(active)
}

/// Watches the JSON inputs and periodically checks files missed by notify, including `@file:` scripts.
async fn watch_json(
    store: PgCatalogProvider,
    loader: JsonFileCatalogProvider,
    mut previous: Option<FileReads>,
) {
    let (tx, mut rx) = mpsc::channel(1);
    let watcher = match loader.watch_files(tx.clone()) {
        Ok(watcher) => Some(watcher),
        Err(err) => {
            warn!(error = %err, "JSON file watcher unavailable; using periodic checks");
            None
        }
    };
    let mut periodic = time::interval(Duration::from_secs(10));
    periodic.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = periodic.tick() => {},
            event = rx.recv(), if watcher.is_some() => {
                if event.is_none() { break; }
                time::sleep(Duration::from_millis(500)).await;
                while rx.try_recv().is_ok() {}
            }
        }
        match store.accepts_json().await {
            Ok(true) => previous = check_json(&store, &loader, previous).await,
            Ok(false) => return,
            Err(err) => warn!(error = %err, "could not check catalog write mode"),
        }
    }
}

/// Retains the last successful file observation so unchanged inputs do not recompile or write.
async fn check_json(
    store: &PgCatalogProvider,
    loader: &JsonFileCatalogProvider,
    previous: Option<FileReads>,
) -> Option<FileReads> {
    match ingest(store, loader, previous).await {
        Ok(files) => Some(files),
        Err(err) => {
            warn!(error = %err, "JSON catalog sync failed; keeping committed configuration");
            if let Err(err) = store.mark_sync_failed().await {
                warn!(error = %err, "could not record catalog sync status");
            }
            None
        }
    }
}

/// Prepares a stable input snapshot off the async runtime, then commits it if needed.
async fn ingest(
    store: &PgCatalogProvider,
    loader: &JsonFileCatalogProvider,
    previous: Option<FileReads>,
) -> Result<FileReads> {
    let loader = loader.clone();
    let (catalog, files) = tokio::task::spawn_blocking(move || {
        if let Some(files) = previous.filter(FileReads::unchanged) {
            return Ok::<_, anyhow::Error>((None, files));
        }
        let (catalog, files) = loader.load_snapshot()?;
        Ok((Some(catalog), files))
    })
    .await
    .context("JSON catalog check task failed")??;
    if let Some(catalog) = catalog
        && let Some(revision) = store.replace_json(&catalog).await?
    {
        info!(revision, "replaced PostgreSQL catalog from JSON");
    }
    Ok(files)
}

/// Loads and swaps newer snapshots, keeping the previous one on transient errors.
async fn refresh_runtime(store: PgCatalogProvider, active: Arc<ArcSwap<RuntimeCatalog>>) {
    let mut ticks = time::interval(Duration::from_secs(2));
    ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        ticks.tick().await;
        if let Err(err) = refresh_once(&store, &active).await {
            warn!(error = %err, "PostgreSQL catalog refresh failed; keeping loaded configuration");
        }
    }
}

/// Applies a committed revision only after full loading and validation succeeds.
async fn refresh_once(store: &PgCatalogProvider, active: &ArcSwap<RuntimeCatalog>) -> Result<()> {
    let loaded = active.load().revision();
    if store.revision().await? != loaded {
        let next = store.load_catalog().await?;
        if next.revision() != loaded {
            info!(revision = next.revision(), "activated PostgreSQL catalog");
            active.store(Arc::new(next));
        }
    }
    Ok(())
}
