//! Optional Redis client wrapper with connection management, fail-open degradation,
//! namespace prefixing, and latency/hit-rate telemetry counters.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow};
use redis::AsyncCommands;
use redis::aio::{ConnectionManager, ConnectionManagerConfig, PubSub};
use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio::sync::RwLock;
use tracing::{info, warn};

use crate::config::RedisConfig;

/// Snapshot of Redis client connectivity, command throughput, hit rate, and latency.
#[derive(Debug, Clone, Copy, Default)]
pub struct RedisStats {
    /// Whether Redis is currently connected and healthy.
    pub connected: bool,
    /// Cumulative Redis commands executed.
    pub ops_total: u64,
    /// Cumulative cache/lookup hits.
    pub hits: u64,
    /// Cumulative cache/lookup misses.
    pub misses: u64,
    /// Cumulative write/delete/publish commands.
    pub writes: u64,
    /// Cumulative command/timeout errors.
    pub errors: u64,
    /// Cumulative command latency in microseconds.
    pub latency_us_sum: u64,
    /// Number of completed timed commands.
    pub latency_count: u64,
    /// Most recent command latency in microseconds.
    pub last_latency_us: u64,
}

/// Lock-free atomic counters for Redis operations.
#[derive(Debug, Default)]
struct RedisCounters {
    /// Current connection health state.
    connected: AtomicBool,
    /// Total commands attempted.
    ops_total: AtomicU64,
    /// Total read hits.
    hits: AtomicU64,
    /// Total read misses.
    misses: AtomicU64,
    /// Total write/delete/publish operations.
    writes: AtomicU64,
    /// Total command/connection errors.
    errors: AtomicU64,
    /// Sum of command latencies in microseconds.
    latency_us_sum: AtomicU64,
    /// Count of completed latency samples.
    latency_count: AtomicU64,
    /// Latest command latency in microseconds.
    last_latency_us: AtomicU64,
}

impl RedisCounters {
    /// Records a completed command latency and clears/sets error state.
    fn record_ok(&self, elapsed: Duration) {
        let us = u64::try_from(elapsed.as_micros()).unwrap_or(u64::MAX);
        self.connected.store(true, Ordering::Relaxed);
        self.ops_total.fetch_add(1, Ordering::Relaxed);
        self.latency_us_sum.fetch_add(us, Ordering::Relaxed);
        self.latency_count.fetch_add(1, Ordering::Relaxed);
        self.last_latency_us.store(us, Ordering::Relaxed);
    }

    /// Records a failed or timed-out command.
    fn record_err(&self, elapsed: Duration, mark_disconnected: bool) {
        let us = u64::try_from(elapsed.as_micros()).unwrap_or(u64::MAX);
        if mark_disconnected {
            self.connected.store(false, Ordering::Relaxed);
        }
        self.ops_total.fetch_add(1, Ordering::Relaxed);
        self.errors.fetch_add(1, Ordering::Relaxed);
        self.latency_us_sum.fetch_add(us, Ordering::Relaxed);
        self.latency_count.fetch_add(1, Ordering::Relaxed);
        self.last_latency_us.store(us, Ordering::Relaxed);
    }
}

/// Thread-safe, cloneable Redis store with automatic reconnect and fail-open degradation.
#[derive(Clone)]
pub struct RedisStore {
    /// Normalized configuration.
    config: RedisConfig,
    /// Underlying Redis client (used for initial connect and dedicated Pub/Sub).
    client: redis::Client,
    /// Multiplexed auto-reconnecting command connection.
    conn: Arc<RwLock<Option<ConnectionManager>>>,
    /// Telemetry counters.
    counters: Arc<RedisCounters>,
}

impl std::fmt::Debug for RedisStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RedisStore")
            .field("config", &self.config)
            .field(
                "connected",
                &self.counters.connected.load(Ordering::Relaxed),
            )
            .finish_non_exhaustive()
    }
}

impl RedisStore {
    /// Initializes a `RedisStore` if `config.enabled` is `true`, otherwise returns `Ok(None)`.
    ///
    /// When `config.fail_open` is `true`, initial connection failures log a warning and spawn
    /// a background reconnect task instead of aborting gateway startup.
    ///
    /// # Errors
    /// Returns an error if the Redis URL is invalid, or if initial connection fails when
    /// `config.fail_open` is `false`.
    pub async fn connect(config: &RedisConfig) -> Result<Option<Self>> {
        if !config.enabled {
            return Ok(None);
        }

        let client = redis::Client::open(config.url.as_str())
            .context("invalid [redis].url connection string")?;

        let store = Self {
            config: config.clone(),
            client,
            conn: Arc::new(RwLock::new(None)),
            counters: Arc::new(RedisCounters::default()),
        };

        match store.try_establish_connection().await {
            Ok(()) => {
                let _ = store.ping().await?;
                info!(key_prefix = %store.prefix(), "connected to Redis");
            }
            Err(err) if config.fail_open => {
                warn!(error = %err, "initial Redis connection failed; continuing in fail-open degraded mode");
            }
            Err(err) => {
                return Err(err).context("failed to connect to Redis (fail_open=false)");
            }
        }

        store.spawn_reconnect_loop();
        Ok(Some(store))
    }

    /// Builds a namespaced Redis key under `{key_prefix}:{subkey}`.
    #[must_use]
    pub fn key(&self, subkey: &str) -> String {
        format!("{}:{}", self.prefix(), subkey)
    }

    /// Returns the normalized non-empty key prefix.
    #[must_use]
    pub fn prefix(&self) -> &str {
        let trimmed = self.config.key_prefix.trim();
        if trimmed.is_empty() {
            "linguist"
        } else {
            trimmed
        }
    }

    /// Returns whether `fail_open` degradation is enabled.
    #[must_use]
    pub const fn fail_open(&self) -> bool {
        self.config.fail_open
    }

    /// Returns whether Redis Pub/Sub catalog sync is enabled.
    #[must_use]
    pub const fn pubsub_enabled(&self) -> bool {
        self.config.pubsub_enabled
    }

    /// Returns current Redis telemetry snapshot.
    #[must_use]
    pub fn stats(&self) -> RedisStats {
        RedisStats {
            connected: self.counters.connected.load(Ordering::Relaxed),
            ops_total: self.counters.ops_total.load(Ordering::Relaxed),
            hits: self.counters.hits.load(Ordering::Relaxed),
            misses: self.counters.misses.load(Ordering::Relaxed),
            writes: self.counters.writes.load(Ordering::Relaxed),
            errors: self.counters.errors.load(Ordering::Relaxed),
            latency_us_sum: self.counters.latency_us_sum.load(Ordering::Relaxed),
            latency_count: self.counters.latency_count.load(Ordering::Relaxed),
            last_latency_us: self.counters.last_latency_us.load(Ordering::Relaxed),
        }
    }

    /// Executes `PING` against Redis and returns round-trip latency in microseconds.
    ///
    /// # Errors
    /// Returns an error if disconnected or the command fails/times out.
    pub async fn ping(&self) -> Result<u64> {
        let mut conn = self.get_conn().await?;
        let t0 = Instant::now();
        let res = tokio::time::timeout(
            self.cmd_timeout(),
            redis::cmd("PING").query_async::<String>(&mut conn),
        )
        .await;
        let elapsed = t0.elapsed();
        match res {
            Ok(Ok(_pong)) => {
                self.counters.record_ok(elapsed);
                Ok(u64::try_from(elapsed.as_micros()).unwrap_or(u64::MAX))
            }
            Ok(Err(err)) => {
                self.counters.record_err(elapsed, true);
                Err(anyhow!("Redis PING failed: {err}"))
            }
            Err(_) => {
                self.counters.record_err(elapsed, true);
                Err(anyhow!("Redis PING timed out"))
            }
        }
    }

    /// Reads and deserializes a JSON value from `key`.
    ///
    /// # Errors
    /// Returns an error if Redis is unavailable, times out, or JSON decoding fails.
    pub async fn get_json<T: DeserializeOwned>(&self, key: &str) -> Result<Option<T>> {
        let mut conn = self.get_conn().await?;
        let t0 = Instant::now();
        let res =
            tokio::time::timeout(self.cmd_timeout(), conn.get::<_, Option<String>>(key)).await;
        let elapsed = t0.elapsed();
        match res {
            Ok(Ok(Some(raw))) => {
                self.counters.record_ok(elapsed);
                self.counters.hits.fetch_add(1, Ordering::Relaxed);
                let parsed: T = serde_json::from_str(&raw)
                    .with_context(|| format!("failed to decode Redis JSON for '{key}'"))?;
                Ok(Some(parsed))
            }
            Ok(Ok(None)) => {
                self.counters.record_ok(elapsed);
                self.counters.misses.fetch_add(1, Ordering::Relaxed);
                Ok(None)
            }
            Ok(Err(err)) => {
                self.counters.record_err(elapsed, is_connection_error(&err));
                Err(anyhow!("Redis GET '{key}' failed: {err}"))
            }
            Err(_) => {
                self.counters.record_err(elapsed, true);
                Err(anyhow!("Redis GET '{key}' timed out"))
            }
        }
    }

    /// Atomically reads and deletes a JSON value (`GETDEL`) for single-use tokens.
    ///
    /// # Errors
    /// Returns an error if Redis is unavailable, times out, or JSON decoding fails.
    pub async fn get_del_json<T: DeserializeOwned>(&self, key: &str) -> Result<Option<T>> {
        let mut conn = self.get_conn().await?;
        let t0 = Instant::now();
        let res = tokio::time::timeout(
            self.cmd_timeout(),
            redis::cmd("GETDEL")
                .arg(key)
                .query_async::<Option<String>>(&mut conn),
        )
        .await;
        let elapsed = t0.elapsed();
        match res {
            Ok(Ok(Some(raw))) => {
                self.counters.record_ok(elapsed);
                self.counters.hits.fetch_add(1, Ordering::Relaxed);
                let parsed: T = serde_json::from_str(&raw)
                    .with_context(|| format!("failed to decode Redis JSON for '{key}'"))?;
                Ok(Some(parsed))
            }
            Ok(Ok(None)) => {
                self.counters.record_ok(elapsed);
                self.counters.misses.fetch_add(1, Ordering::Relaxed);
                Ok(None)
            }
            Ok(Err(err)) => {
                self.counters.record_err(elapsed, is_connection_error(&err));
                Err(anyhow!("Redis GETDEL '{key}' failed: {err}"))
            }
            Err(_) => {
                self.counters.record_err(elapsed, true);
                Err(anyhow!("Redis GETDEL '{key}' timed out"))
            }
        }
    }

    /// Serializes `value` as JSON and writes it to `key` with expiration `ttl_secs`.
    ///
    /// # Errors
    /// Returns an error if serialization, Redis write, or timeout fails.
    pub async fn set_json_ex<T: Serialize>(
        &self,
        key: &str,
        value: &T,
        ttl_secs: u64,
    ) -> Result<()> {
        let raw = serde_json::to_string(value)
            .with_context(|| format!("failed to serialize Redis JSON for '{key}'"))?;
        let mut conn = self.get_conn().await?;
        let t0 = Instant::now();
        let ttl = ttl_secs.max(1);
        let res =
            tokio::time::timeout(self.cmd_timeout(), conn.set_ex::<_, _, ()>(key, raw, ttl)).await;
        let elapsed = t0.elapsed();
        match res {
            Ok(Ok(())) => {
                self.counters.record_ok(elapsed);
                self.counters.writes.fetch_add(1, Ordering::Relaxed);
                Ok(())
            }
            Ok(Err(err)) => {
                self.counters.record_err(elapsed, is_connection_error(&err));
                Err(anyhow!("Redis SETEX '{key}' failed: {err}"))
            }
            Err(_) => {
                self.counters.record_err(elapsed, true);
                Err(anyhow!("Redis SETEX '{key}' timed out"))
            }
        }
    }

    /// Deletes a key from Redis.
    ///
    /// # Errors
    /// Returns an error if Redis is unavailable or the command fails.
    pub async fn del(&self, key: &str) -> Result<()> {
        let mut conn = self.get_conn().await?;
        let t0 = Instant::now();
        let res = tokio::time::timeout(self.cmd_timeout(), conn.del::<_, ()>(key)).await;
        let elapsed = t0.elapsed();
        match res {
            Ok(Ok(())) => {
                self.counters.record_ok(elapsed);
                self.counters.writes.fetch_add(1, Ordering::Relaxed);
                Ok(())
            }
            Ok(Err(err)) => {
                self.counters.record_err(elapsed, is_connection_error(&err));
                Err(anyhow!("Redis DEL '{key}' failed: {err}"))
            }
            Err(_) => {
                self.counters.record_err(elapsed, true);
                Err(anyhow!("Redis DEL '{key}' timed out"))
            }
        }
    }

    /// Publishes a message to a Redis Pub/Sub channel.
    ///
    /// # Errors
    /// Returns an error if Redis is unavailable or the publish fails.
    pub async fn publish(&self, channel: &str, message: &str) -> Result<()> {
        let mut conn = self.get_conn().await?;
        let t0 = Instant::now();
        let res = tokio::time::timeout(
            self.cmd_timeout(),
            conn.publish::<_, _, i64>(channel, message),
        )
        .await;
        let elapsed = t0.elapsed();
        match res {
            Ok(Ok(_)) => {
                self.counters.record_ok(elapsed);
                self.counters.writes.fetch_add(1, Ordering::Relaxed);
                Ok(())
            }
            Ok(Err(err)) => {
                self.counters.record_err(elapsed, is_connection_error(&err));
                Err(anyhow!("Redis PUBLISH '{channel}' failed: {err}"))
            }
            Err(_) => {
                self.counters.record_err(elapsed, true);
                Err(anyhow!("Redis PUBLISH '{channel}' timed out"))
            }
        }
    }

    /// Opens a dedicated async Pub/Sub connection subscribed to `channel`.
    ///
    /// # Errors
    /// Returns an error if connecting or subscribing fails.
    pub async fn subscribe(&self, channel: &str) -> Result<PubSub> {
        let connect_dur = Duration::from_millis(self.config.connect_timeout_ms.max(100));
        let mut pubsub = tokio::time::timeout(connect_dur, self.client.get_async_pubsub())
            .await
            .map_err(|_| anyhow!("Redis PubSub connect timed out"))?
            .context("failed to open Redis PubSub connection")?;
        tokio::time::timeout(self.cmd_timeout(), pubsub.subscribe(channel))
            .await
            .map_err(|_| anyhow!("Redis SUBSCRIBE '{channel}' timed out"))?
            .with_context(|| format!("failed to subscribe to Redis channel '{channel}'"))?;
        Ok(pubsub)
    }

    /// Returns the configured per-command timeout.
    fn cmd_timeout(&self) -> Duration {
        Duration::from_millis(self.config.command_timeout_ms.max(20))
    }

    /// Returns a cloned `ConnectionManager` or an error if not yet connected.
    async fn get_conn(&self) -> Result<ConnectionManager> {
        let guard = self.conn.read().await;
        guard
            .clone()
            .ok_or_else(|| anyhow!("Redis connection is not established"))
    }

    /// Attempts to build and store a `ConnectionManager`.
    async fn try_establish_connection(&self) -> Result<()> {
        let connect_timeout = Duration::from_millis(self.config.connect_timeout_ms.max(100));
        let response_timeout = self.cmd_timeout();
        let mgr_cfg = ConnectionManagerConfig::new()
            .set_connection_timeout(Some(connect_timeout))
            .set_response_timeout(Some(response_timeout));

        let mgr = tokio::time::timeout(
            connect_timeout + Duration::from_millis(200),
            ConnectionManager::new_with_config(self.client.clone(), mgr_cfg),
        )
        .await
        .map_err(|_| anyhow!("Redis connection attempt timed out"))?
        .context("failed to establish Redis ConnectionManager")?;

        let mut guard = self.conn.write().await;
        *guard = Some(mgr);
        self.counters.connected.store(true, Ordering::Relaxed);
        Ok(())
    }

    /// Spawns a background task that establishes initial connection (if degraded) and
    /// periodically checks Redis health with `PING`.
    fn spawn_reconnect_loop(&self) {
        let store = self.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_secs(10));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                let has_conn = store.conn.read().await.is_some();
                if !has_conn {
                    if let Err(err) = store.try_establish_connection().await {
                        store.counters.connected.store(false, Ordering::Relaxed);
                        warn!(error = %err, "Redis reconnect attempt failed");
                    } else if store.ping().await.is_ok() {
                        info!("Redis connection restored");
                    }
                } else if !store.counters.connected.load(Ordering::Relaxed) {
                    let _ = store.ping().await;
                }
            }
        });
    }
}

/// Checks if a `redis::RedisError` represents a connection/IO failure.
fn is_connection_error(err: &redis::RedisError) -> bool {
    err.is_io_error() || err.is_connection_dropped() || err.is_connection_refusal()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn disabled_redis_returns_none() {
        let cfg = RedisConfig::default();
        let res = RedisStore::connect(&cfg).await;
        assert!(res.is_ok());
        assert!(matches!(res, Ok(None)));
    }

    #[tokio::test]
    #[ignore = "requires a Redis server via REDIS_URL"]
    async fn live_redis_ping_get_set_getdel_and_del() {
        let url =
            std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379/0".to_string());
        let cfg = RedisConfig {
            enabled: true,
            url,
            key_prefix: "linguist_test".to_string(),
            fail_open: false,
            ..RedisConfig::default()
        };
        let store = RedisStore::connect(&cfg).await.ok().flatten();
        assert!(store.is_some());
        let Some(store) = store else { return };

        let ping_us = store.ping().await;
        assert!(ping_us.is_ok());

        let k = store.key(&format!("test:{}", uuid::Uuid::new_v4()));
        assert!(
            store
                .set_json_ex(&k, &serde_json::json!({ "ok": true }), 30)
                .await
                .is_ok()
        );
        let got = store.get_json::<serde_json::Value>(&k).await;
        assert!(matches!(got, Ok(Some(_))));

        let consumed = store.get_del_json::<serde_json::Value>(&k).await;
        assert!(matches!(consumed, Ok(Some(_))));
        let after = store.get_json::<serde_json::Value>(&k).await;
        assert!(matches!(after, Ok(None)));

        let stats = store.stats();
        assert!(stats.connected);
        assert!(stats.hits >= 2);
        assert!(stats.misses >= 1);
        assert!(stats.writes >= 1);
        assert_eq!(stats.errors, 0);
    }
}
