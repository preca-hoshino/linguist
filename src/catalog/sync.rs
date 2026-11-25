//! Atomic runtime refresh from committed PostgreSQL revisions.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use arc_swap::ArcSwap;
use tokio::time::{self, MissedTickBehavior};
use tracing::{info, warn};

use super::postgres::PgCatalogProvider;
use super::{CatalogProvider, RuntimeCatalog};

/// Loads the initial PostgreSQL catalog snapshot and spawns the background revision poller.
///
/// # Errors
/// Returns an error if PostgreSQL contains un-migrated v0.1.0 tables or invalid catalog data.
pub async fn start(store: PgCatalogProvider) -> Result<Arc<ArcSwap<RuntimeCatalog>>> {
    store.ensure_v2_schema().await?;
    let initial = store
        .load_catalog()
        .await
        .context("could not load the PostgreSQL catalog")?;
    info!(revision = initial.revision(), "loaded PostgreSQL catalog");
    let active = Arc::new(ArcSwap::from_pointee(initial));
    tokio::spawn(refresh_runtime(store, Arc::clone(&active)));
    Ok(active)
}

/// Immediately reloads and swaps the local `ArcSwap<RuntimeCatalog>` after an admin write.
///
/// # Errors
/// Returns an error if reloading from PostgreSQL fails.
pub async fn reload_now(
    store: &PgCatalogProvider,
    active: &ArcSwap<RuntimeCatalog>,
) -> Result<i64> {
    let next = store.load_catalog().await?;
    let rev = next.revision();
    active.store(Arc::new(next));
    Ok(rev)
}

/// Polls `catalog_state.revision` periodically so multi-instance deployments stay synchronized.
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

/// Applies a committed revision only after full loading and script compilation succeed.
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
