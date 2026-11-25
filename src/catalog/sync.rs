//! Atomic runtime refresh from committed PostgreSQL revisions.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use arc_swap::ArcSwap;
use futures::StreamExt;
use tokio::sync::Notify;
use tokio::time::{self, MissedTickBehavior};
use tracing::{info, warn};

use super::postgres::PgCatalogProvider;
use super::{CatalogProvider, RuntimeCatalog};
use crate::redis_store::RedisStore;

/// Returns the Redis Pub/Sub channel name for catalog revision notifications.
#[must_use]
pub fn catalog_rev_channel(redis: &RedisStore) -> String {
    redis.key("sys:catalog_rev")
}

/// Loads the initial PostgreSQL catalog snapshot and spawns the background revision poller
/// (accelerated by Redis Pub/Sub when enabled).
///
/// # Errors
/// Returns an error if PostgreSQL contains un-migrated v0.1.0 tables or invalid catalog data.
pub async fn start(
    store: PgCatalogProvider,
    redis: Option<RedisStore>,
) -> Result<Arc<ArcSwap<RuntimeCatalog>>> {
    store.ensure_v2_schema().await?;
    let initial = store
        .load_catalog()
        .await
        .context("could not load the PostgreSQL catalog")?;
    info!(revision = initial.revision(), "loaded PostgreSQL catalog");
    let active = Arc::new(ArcSwap::from_pointee(initial));
    let wake = Arc::new(Notify::new());
    let use_pubsub = redis.as_ref().is_some_and(RedisStore::pubsub_enabled);
    if let Some(redis_store) = redis
        && use_pubsub
    {
        tokio::spawn(subscribe_catalog_updates(redis_store, Arc::clone(&wake)));
    }
    let poll_secs = if use_pubsub { 15 } else { 2 };
    tokio::spawn(refresh_runtime(store, Arc::clone(&active), wake, poll_secs));
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

/// Subscribes to Redis Pub/Sub catalog revision notifications and wakes `refresh_runtime`.
async fn subscribe_catalog_updates(redis: RedisStore, wake: Arc<Notify>) {
    let channel = catalog_rev_channel(&redis);
    loop {
        match redis.subscribe(&channel).await {
            Ok(mut pubsub) => {
                info!(%channel, "subscribed to Redis catalog revision channel");
                let mut stream = pubsub.on_message();
                while let Some(_msg) = stream.next().await {
                    wake.notify_one();
                }
                warn!(%channel, "Redis catalog Pub/Sub stream ended; reconnecting");
            }
            Err(err) => {
                warn!(%channel, error = %err, "Redis catalog Pub/Sub subscribe failed; retrying");
            }
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

/// Polls `catalog_state.revision` periodically (and on Pub/Sub wakeups) so multi-instance
/// deployments stay synchronized.
async fn refresh_runtime(
    store: PgCatalogProvider,
    active: Arc<ArcSwap<RuntimeCatalog>>,
    wake: Arc<Notify>,
    poll_secs: u64,
) {
    let mut ticks = time::interval(Duration::from_secs(poll_secs));
    ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = ticks.tick() => {}
            () = wake.notified() => {}
        }
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
