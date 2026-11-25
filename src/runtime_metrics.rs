//! In-process runtime telemetry: process memory/CPU/FD probing, inbound/outbound HTTP
//! byte & request counters, dual-tier ring-buffer sampler, and `/monitoring/runtime` DTOs.

use std::collections::VecDeque;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::header::{CONTENT_LENGTH, CONTENT_TYPE};
use axum::middleware::Next;
use axum::response::Response;
use bytes::Bytes;
use chrono::Utc;
use futures::Stream;
use serde::Serialize;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};

use crate::state::AppState;

/// Fine-grained sampler interval in seconds.
const FINE_INTERVAL_SECS: u64 = 5;
/// Maximum fine-grained samples retained (`720 * 5s = 1 hour`).
const FINE_CAPACITY: usize = 720;
/// Number of 5-second ticks aggregated into one coarse 60-second sample.
const COARSE_STRIDE: usize = 12;
/// Maximum coarse samples retained (`1440 * 60s = 24 hours`).
const COARSE_CAPACITY: usize = 1440;

/// Route-group index for inbound HTTP breakdowns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(usize)]
pub enum RouteGroup {
    /// `POST /model/{project_id}/v1/chat/completions`
    ProxyChat = 0,
    /// `GET /model/{project_id}/v1/models`
    ProxyModels = 1,
    /// `GET /api/v1/stats/*`
    StatsApi = 2,
    /// `/api/v1/catalog/*` and `/api/v1/billing/*`
    AdminApi = 3,
    /// `/auth/*` OIDC routes
    Auth = 4,
    /// `GET /healthz`
    Healthz = 5,
    /// Static SPA assets and `/icons/*`
    Static = 6,
}

impl RouteGroup {
    /// Total number of route groups.
    const COUNT: usize = 7;

    /// Classifies an incoming request URI path into a `RouteGroup`.
    #[must_use]
    pub fn classify(path: &str) -> Self {
        if path.starts_with("/model/") {
            if path.ends_with("/chat/completions") {
                Self::ProxyChat
            } else {
                Self::ProxyModels
            }
        } else if path.starts_with("/api/v1/stats/") {
            Self::StatsApi
        } else if path.starts_with("/api/") {
            Self::AdminApi
        } else if path.starts_with("/auth/") {
            Self::Auth
        } else if path == "/healthz" {
            Self::Healthz
        } else {
            Self::Static
        }
    }

    /// Human-readable Chinese label and route pattern for UI tables.
    #[must_use]
    pub const fn meta(self) -> (&'static str, &'static str) {
        match self {
            Self::ProxyChat => ("proxy_chat", "AI 代理 (/model/*/chat/completions)"),
            Self::ProxyModels => ("proxy_models", "模型列表 (/model/*/models)"),
            Self::StatsApi => ("stats_api", "统计与日志 (/api/v1/stats/*)"),
            Self::AdminApi => ("admin_api", "配置与计费 (/api/v1/*)"),
            Self::Auth => ("auth", "OIDC 鉴权 (/auth/*)"),
            Self::Healthz => ("healthz", "健康检查 (/healthz)"),
            Self::Static => ("static", "前端静态资源与图标"),
        }
    }

    /// Iterates over all route groups in display order.
    const fn all() -> [Self; Self::COUNT] {
        [
            Self::ProxyChat,
            Self::ProxyModels,
            Self::StatsApi,
            Self::AdminApi,
            Self::Auth,
            Self::Healthz,
            Self::Static,
        ]
    }
}

/// Atomic counters for one inbound HTTP route group.
#[derive(Debug, Default)]
struct RouteGroupCounters {
    /// Total completed + active requests.
    total: AtomicU64,
    /// Active inflight requests.
    inflight: AtomicU64,
    /// HTTP 2xx responses.
    s2xx: AtomicU64,
    /// HTTP 4xx responses.
    s4xx: AtomicU64,
    /// HTTP 5xx responses.
    s5xx: AtomicU64,
    /// Inbound request bytes (`Content-Length`).
    req_bytes: AtomicU64,
    /// Outbound response bytes streamed/sent to client.
    resp_bytes: AtomicU64,
    /// Cumulative response duration in microseconds.
    duration_us_sum: AtomicU64,
    /// Completed request count for duration average.
    completed_count: AtomicU64,
}

/// Lock-free atomic counters updated on hot paths across the gateway.
#[derive(Debug, Default)]
pub struct RuntimeCounters {
    /// Active inbound HTTP requests.
    pub inbound_inflight: AtomicU64,
    /// Active open SSE response streams.
    pub active_sse_streams: AtomicU64,
    /// Total inbound HTTP requests received.
    pub inbound_total: AtomicU64,
    /// Inbound 2xx responses.
    pub inbound_2xx: AtomicU64,
    /// Inbound 3xx responses.
    pub inbound_3xx: AtomicU64,
    /// Inbound 4xx responses.
    pub inbound_4xx: AtomicU64,
    /// Inbound 5xx responses.
    pub inbound_5xx: AtomicU64,
    /// Total inbound request bytes received.
    pub inbound_req_bytes: AtomicU64,
    /// Total inbound response bytes sent to downstream clients.
    pub inbound_resp_bytes: AtomicU64,
    /// Per-route-group counters.
    groups: [RouteGroupCounters; RouteGroup::COUNT],

    /// Active outbound upstream requests.
    pub outbound_inflight: AtomicU64,
    /// Total outbound upstream HTTP attempts.
    pub outbound_total: AtomicU64,
    /// Outbound upstream 2xx responses.
    pub outbound_2xx: AtomicU64,
    /// Outbound upstream 429 rate-limit responses.
    pub outbound_429: AtomicU64,
    /// Outbound upstream 4xx (excluding 429) responses.
    pub outbound_4xx: AtomicU64,
    /// Outbound upstream 5xx responses.
    pub outbound_5xx: AtomicU64,
    /// Outbound upstream transport/timeout errors.
    pub outbound_conn_err: AtomicU64,
    /// Total outbound request bytes sent to upstream providers.
    pub outbound_req_bytes: AtomicU64,
    /// Total outbound response bytes received from upstream providers.
    pub outbound_resp_bytes: AtomicU64,
    /// Upstream fallback/retry count (`attempt > 1`).
    pub outbound_retry_count: AtomicU64,
    /// Interrupted SSE streams.
    pub outbound_sse_interrupted: AtomicU64,
    /// Cumulative outbound upstream duration in microseconds.
    pub outbound_duration_us_sum: AtomicU64,
    /// Completed outbound upstream attempts for duration average.
    pub outbound_completed_count: AtomicU64,

    /// Cumulative gateway routing stage duration in microseconds.
    pub routing_us_sum: AtomicU64,
    /// Count of recorded routing durations.
    pub routing_count: AtomicU64,
    /// Cumulative attempt preparation duration in microseconds.
    pub prep_us_sum: AtomicU64,
    /// Count of recorded prep durations.
    pub prep_count: AtomicU64,
}

/// Process memory/CPU/FD snapshot read from `sysinfo` and Linux procfs/cgroup.
#[derive(Debug, Clone, Default)]
struct ProcessMetrics {
    /// Current process resident set size in bytes.
    rss_bytes: u64,
    /// Peak observed RSS in bytes.
    peak_rss_bytes: u64,
    /// Process virtual memory size in bytes.
    virtual_bytes: u64,
    /// Process CPU usage percentage.
    cpu_percent: f64,
    /// System total memory in bytes.
    system_total_bytes: u64,
    /// System used memory in bytes.
    system_used_bytes: u64,
    /// Linux cgroup current memory usage in bytes, if available.
    cgroup_memory_bytes: Option<u64>,
    /// Linux cgroup memory limit in bytes, if finite.
    cgroup_limit_bytes: Option<u64>,
    /// Open file descriptors count (Linux `/proc/self/fd`).
    open_fds: Option<u64>,
    /// Process thread count.
    threads: Option<u64>,
}

/// Previous atomic counter totals used to compute per-interval rates.
#[derive(Debug, Clone, Default)]
struct PrevSnapshot {
    /// Previous inbound total requests.
    inbound_total: u64,
    /// Previous inbound proxy requests.
    inbound_proxy: u64,
    /// Previous inbound API/auth requests.
    inbound_api: u64,
    /// Previous inbound other requests.
    inbound_other: u64,
    /// Previous inbound 2xx count.
    inbound_2xx: u64,
    /// Previous inbound 3xx count.
    inbound_3xx: u64,
    /// Previous inbound 4xx count.
    inbound_4xx: u64,
    /// Previous inbound 5xx count.
    inbound_5xx: u64,
    /// Previous inbound request bytes.
    inbound_req_bytes: u64,
    /// Previous inbound response bytes.
    inbound_resp_bytes: u64,
    /// Previous outbound total requests.
    outbound_total: u64,
    /// Previous outbound 2xx count.
    outbound_2xx: u64,
    /// Previous outbound 429 count.
    outbound_429: u64,
    /// Previous outbound 4xx/5xx error count.
    outbound_err: u64,
    /// Previous outbound connection error count.
    outbound_conn_err: u64,
    /// Previous outbound SSE interruption count.
    outbound_sse_interrupted: u64,
    /// Previous outbound request bytes.
    outbound_req_bytes: u64,
    /// Previous outbound response bytes.
    outbound_resp_bytes: u64,
    /// Previous routing duration sum in microseconds.
    routing_us_sum: u64,
    /// Previous routing duration count.
    routing_count: u64,
    /// Previous attempt prep duration sum in microseconds.
    prep_us_sum: u64,
    /// Previous attempt prep duration count.
    prep_count: u64,
    /// Previous script call count.
    script_calls: u64,
    /// Previous script error count.
    script_errors: u64,
    /// Previous persisted log count.
    log_persisted: u64,
    /// Previous Redis hits count.
    redis_hits: u64,
    /// Previous Redis misses count.
    redis_misses: u64,
    /// Previous Redis writes count.
    redis_writes: u64,
    /// Previous Redis errors count.
    redis_errors: u64,
    /// Previous Redis latency sum in microseconds.
    redis_latency_us_sum: u64,
    /// Previous Redis latency sample count.
    redis_latency_count: u64,
}

/// One time-bucketed point in the runtime monitoring time series.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSample {
    /// Formatted local/UTC time label (`HH:MM:SS` or `HH:MM`).
    pub label: String,
    /// Process RSS memory in MiB.
    pub rss_mb: f64,
    /// Peak RSS memory in MiB.
    pub peak_rss_mb: f64,
    /// Container cgroup memory in MiB (if running in cgroup).
    pub cgroup_mb: Option<f64>,
    /// Process CPU usage percent.
    pub cpu_percent: f64,
    /// Open file descriptors (if available).
    pub open_fds: Option<u64>,
    /// Process thread count (if available).
    pub threads: Option<u64>,
    /// Active inbound HTTP requests at sample instant.
    pub inbound_inflight: u64,
    /// Active SSE streams at sample instant.
    pub active_sse_streams: u64,
    /// Active outbound upstream requests at sample instant.
    pub outbound_inflight: u64,
    /// Inbound requests per second over interval.
    pub inbound_rps: f64,
    /// Inbound proxy (`/model/*`) requests per second.
    pub inbound_proxy_rps: f64,
    /// Inbound console/auth (`/api/*`, `/auth/*`) requests per second.
    pub inbound_api_rps: f64,
    /// Inbound other (`/healthz`, static) requests per second.
    pub inbound_other_rps: f64,
    /// Inbound 2xx responses in interval.
    pub inbound_2xx: u64,
    /// Inbound 3xx responses in interval.
    pub inbound_3xx: u64,
    /// Inbound 4xx responses in interval.
    pub inbound_4xx: u64,
    /// Inbound 5xx responses in interval.
    pub inbound_5xx: u64,
    /// Inbound request bytes/sec (RX).
    pub inbound_rx_bps: f64,
    /// Inbound response bytes/sec (TX).
    pub inbound_tx_bps: f64,
    /// Outbound upstream requests per second over interval.
    pub outbound_rps: f64,
    /// Outbound upstream 2xx in interval.
    pub outbound_2xx: u64,
    /// Outbound upstream 429 in interval.
    pub outbound_429: u64,
    /// Outbound upstream 4xx/5xx errors in interval.
    pub outbound_err: u64,
    /// Outbound connection/timeout errors in interval.
    pub outbound_conn_err: u64,
    /// Outbound SSE interruptions in interval.
    pub outbound_sse_interrupted: u64,
    /// Outbound request bytes/sec (TX).
    pub outbound_tx_bps: f64,
    /// Outbound response bytes/sec (RX).
    pub outbound_rx_bps: f64,
    /// Average gateway routing stage latency in ms during interval.
    pub avg_routing_ms: f64,
    /// Average gateway attempt prep latency in ms during interval.
    pub avg_prep_ms: f64,
    /// Active PG pool connections at sample instant.
    pub pg_active: u32,
    /// Idle PG pool connections at sample instant.
    pub pg_idle: u32,
    /// Pending `LogWriterHandle` queue depth at sample instant.
    pub log_queue_depth: u64,
    /// Logs persisted per second during interval.
    pub log_persisted_rps: f64,
    /// Script invocations per second during interval.
    pub script_calls_rps: f64,
    /// Script errors during interval.
    pub script_errors: u64,
    /// Redis read hits per second during interval.
    pub redis_hits_rps: f64,
    /// Redis read misses per second during interval.
    pub redis_misses_rps: f64,
    /// Redis write/publish ops per second during interval.
    pub redis_writes_rps: f64,
    /// Redis errors during interval.
    pub redis_errors: u64,
    /// Average Redis command latency in ms during interval.
    pub redis_avg_latency_ms: f64,
}

/// Real-time instantaneous snapshot of process, pool, cache, and HTTP totals.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    /// Process uptime in seconds.
    pub uptime_secs: u64,
    /// Operating system target (`linux`, `windows`, etc.).
    pub os: &'static str,
    /// Current RSS memory in bytes.
    pub rss_bytes: u64,
    /// Peak observed RSS memory in bytes.
    pub peak_rss_bytes: u64,
    /// Virtual memory in bytes.
    pub virtual_bytes: u64,
    /// System total memory in bytes.
    pub system_total_bytes: u64,
    /// System used memory in bytes.
    pub system_used_bytes: u64,
    /// Cgroup current memory in bytes.
    pub cgroup_memory_bytes: Option<u64>,
    /// Cgroup memory limit in bytes.
    pub cgroup_limit_bytes: Option<u64>,
    /// Process CPU usage %.
    pub cpu_percent: f64,
    /// Open FD count (Linux).
    pub open_fds: Option<u64>,
    /// Process thread count.
    pub threads: Option<u64>,
    /// Active inbound HTTP requests.
    pub inbound_inflight: u64,
    /// Active SSE streams.
    pub active_sse_streams: u64,
    /// Active outbound upstream requests.
    pub outbound_inflight: u64,
    /// Latest inbound RPS.
    pub current_inbound_rps: f64,
    /// Latest outbound RPS.
    pub current_outbound_rps: f64,
    /// Latest inbound RX bytes/s.
    pub current_inbound_rx_bps: f64,
    /// Latest inbound TX bytes/s.
    pub current_inbound_tx_bps: f64,
    /// Latest outbound TX bytes/s.
    pub current_outbound_tx_bps: f64,
    /// Latest outbound RX bytes/s.
    pub current_outbound_rx_bps: f64,
    /// PG pool total size.
    pub pg_pool_size: u32,
    /// PG pool idle connections.
    pub pg_pool_idle: u32,
    /// PG pool configured max connections.
    pub pg_pool_max: u32,
    /// `LogWriterHandle` current queue depth.
    pub log_queue_depth: u64,
    /// `LogWriterHandle` queue capacity.
    pub log_queue_capacity: u64,
    /// Total logs enqueued.
    pub log_enqueued: u64,
    /// Total logs persisted.
    pub log_persisted: u64,
    /// Total log persist retries.
    pub log_retries: u64,
    /// Total logs dropped due to full channel.
    pub log_dropped: u64,
    /// `MetricsCache` tracked endpoints.
    pub metrics_cache_endpoints: usize,
    /// `MetricsCache` total samples.
    pub metrics_cache_samples: usize,
    /// Active `RuntimeCatalog` revision.
    pub catalog_revision: i64,
    /// Total `onRequest` executions.
    pub script_on_request_calls: u64,
    /// Total `onRequest` errors.
    pub script_on_request_errors: u64,
    /// Total `onBilling` executions.
    pub script_on_billing_calls: u64,
    /// Total `onBilling` errors.
    pub script_on_billing_errors: u64,
    /// Total `linguist.http` calls.
    pub script_http_calls: u64,
    /// Total `linguist.http` cache hits.
    pub script_http_cache_hits: u64,
    /// Total `linguist.http` singleflight coalesced waits.
    pub script_http_singleflight: u64,
    /// Total `linguist.http` SSRF blocks.
    pub script_http_ssrf_blocked: u64,
    /// Total `linguist.http` errors.
    pub script_http_errors: u64,
    /// Current `linguist.http` cached entries.
    pub script_http_cache_entries: usize,
    /// Whether Redis is enabled in configuration.
    pub redis_enabled: bool,
    /// Whether Redis is currently connected.
    pub redis_connected: bool,
    /// Cumulative Redis commands executed.
    pub redis_ops_total: u64,
    /// Cumulative Redis cache/lookup hits.
    pub redis_hits: u64,
    /// Cumulative Redis cache/lookup misses.
    pub redis_misses: u64,
    /// Cumulative Redis write/delete/publish commands.
    pub redis_writes: u64,
    /// Cumulative Redis errors.
    pub redis_errors: u64,
    /// Latest Redis command latency in ms.
    pub redis_last_latency_ms: f64,
    /// Cumulative Redis hit rate percentage (`0.0..=100.0`).
    pub redis_hit_rate: f64,
}

/// One row in the runtime HTTP channel breakdown table.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpChannelRow {
    /// Channel key.
    pub key: String,
    /// Display name.
    pub label: String,
    /// Traffic direction (`inbound` or `outbound`).
    pub direction: &'static str,
    /// Cumulative requests.
    pub total_requests: u64,
    /// Current inflight requests.
    pub inflight: u64,
    /// 2xx count.
    pub s2xx: u64,
    /// 4xx count.
    pub s4xx: u64,
    /// 5xx or transport error count.
    pub s5xx_or_err: u64,
    /// Average response duration in milliseconds.
    pub avg_duration_ms: f64,
    /// Received bytes (`RX`).
    pub rx_bytes: u64,
    /// Sent bytes (`TX`).
    pub tx_bytes: u64,
}

/// Full response DTO for `GET /api/v1/stats/monitoring/runtime`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeMonitoringResponse {
    /// Selected window key (`5m`, `15m`, `1h`, `6h`, `24h`).
    pub window: String,
    /// Sampling interval in seconds for returned `samples`.
    pub interval_secs: u64,
    /// Instantaneous snapshot.
    pub snapshot: RuntimeSnapshot,
    /// Combined inbound & outbound HTTP channel breakdown table.
    pub channels: Vec<HttpChannelRow>,
    /// Ordered time-series samples.
    pub samples: Vec<RuntimeSample>,
}

/// Dual-tier ring buffer state guarded by `Mutex`.
#[derive(Debug)]
struct SamplerBuffer {
    /// Fine-grained 5-second sample buffer (1h).
    fine: VecDeque<RuntimeSample>,
    /// Coarse-grained 60-second sample buffer (24h).
    coarse: VecDeque<RuntimeSample>,
    /// Accumulator of fine samples pending coarse aggregation.
    coarse_acc: Vec<RuntimeSample>,
    /// Previous counter snapshot for interval deltas.
    prev: PrevSnapshot,
    /// Latest probed process metrics.
    last_proc: ProcessMetrics,
    /// `sysinfo` system probe handle.
    sys: Option<System>,
    /// Peak observed RSS memory in bytes.
    peak_rss: u64,
}

impl Default for SamplerBuffer {
    fn default() -> Self {
        let mut sys = System::new().ok();
        if let Some(s) = sys.as_mut() {
            s.refresh_memory();
        }
        Self {
            fine: VecDeque::with_capacity(FINE_CAPACITY),
            coarse: VecDeque::with_capacity(COARSE_CAPACITY),
            coarse_acc: Vec::with_capacity(COARSE_STRIDE),
            prev: PrevSnapshot::default(),
            last_proc: ProcessMetrics::default(),
            sys,
            peak_rss: 0,
        }
    }
}

/// Shared runtime telemetry collector stored in `AppState`.
#[derive(Debug)]
pub struct RuntimeMetrics {
    /// Gateway process start instant.
    pub started_at: Instant,
    /// Atomic counters updated on request/response hot paths.
    pub counters: RuntimeCounters,
    /// Ring buffers and `sysinfo::System` handle.
    buffer: Mutex<SamplerBuffer>,
}

impl Default for RuntimeMetrics {
    fn default() -> Self {
        Self::new()
    }
}

impl RuntimeMetrics {
    /// Creates a new `RuntimeMetrics` collector.
    #[must_use]
    pub fn new() -> Self {
        Self {
            started_at: Instant::now(),
            counters: RuntimeCounters::default(),
            buffer: Mutex::new(SamplerBuffer::default()),
        }
    }

    /// Records a completed outbound upstream attempt duration and status code.
    pub fn record_outbound_status(&self, status: u16, duration_us: u64) {
        self.counters
            .outbound_duration_us_sum
            .fetch_add(duration_us, Ordering::Relaxed);
        self.counters
            .outbound_completed_count
            .fetch_add(1, Ordering::Relaxed);
        if (200..300).contains(&status) {
            self.counters.outbound_2xx.fetch_add(1, Ordering::Relaxed);
        } else if status == 429 {
            self.counters.outbound_429.fetch_add(1, Ordering::Relaxed);
        } else if (400..500).contains(&status) {
            self.counters.outbound_4xx.fetch_add(1, Ordering::Relaxed);
        } else {
            self.counters.outbound_5xx.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Records an outbound transport/connection error before HTTP status.
    pub fn record_outbound_conn_error(&self, duration_us: u64) {
        self.counters
            .outbound_duration_us_sum
            .fetch_add(duration_us, Ordering::Relaxed);
        self.counters
            .outbound_completed_count
            .fetch_add(1, Ordering::Relaxed);
        self.counters
            .outbound_conn_err
            .fetch_add(1, Ordering::Relaxed);
    }

    /// Records gateway routing and prep durations in microseconds.
    pub fn record_gateway_timings(&self, routing_ms: f64, prep_ms: f64) {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let r_us = (routing_ms.max(0.0) * 1000.0) as u64;
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let p_us = (prep_ms.max(0.0) * 1000.0) as u64;
        self.counters
            .routing_us_sum
            .fetch_add(r_us, Ordering::Relaxed);
        self.counters.routing_count.fetch_add(1, Ordering::Relaxed);
        self.counters.prep_us_sum.fetch_add(p_us, Ordering::Relaxed);
        self.counters.prep_count.fetch_add(1, Ordering::Relaxed);
    }

    /// Samples current process, pool, cache, and counter deltas into the ring buffer.
    #[allow(clippy::too_many_lines)]
    pub fn collect_sample(&self, state: &AppState) {
        let log_stats = state
            .log_writer
            .as_ref()
            .map_or_default(crate::db::LogWriterHandle::stats);
        let script_stats = state.engine.runtime_stats();
        let redis_stats = state
            .redis
            .as_ref()
            .map_or_default(crate::redis_store::RedisStore::stats);
        let (pg_size, pg_idle) = state.db_pool.as_ref().map_or((0, 0), |p| {
            (p.size(), u32::try_from(p.num_idle()).unwrap_or(0))
        });
        let pg_active = pg_size.saturating_sub(pg_idle);

        let Ok(mut guard) = self.buffer.lock() else {
            return;
        };

        let proc_metrics = {
            let buf = &mut *guard;
            probe_process_metrics(buf.sys.as_mut(), &mut buf.peak_rss)
        };
        guard.last_proc = proc_metrics.clone();

        let cur_total = self.counters.inbound_total.load(Ordering::Relaxed);
        let cur_proxy = self.counters.groups[RouteGroup::ProxyChat as usize]
            .total
            .load(Ordering::Relaxed)
            + self.counters.groups[RouteGroup::ProxyModels as usize]
                .total
                .load(Ordering::Relaxed);
        let cur_api = self.counters.groups[RouteGroup::StatsApi as usize]
            .total
            .load(Ordering::Relaxed)
            + self.counters.groups[RouteGroup::AdminApi as usize]
                .total
                .load(Ordering::Relaxed)
            + self.counters.groups[RouteGroup::Auth as usize]
                .total
                .load(Ordering::Relaxed);
        let cur_other = self.counters.groups[RouteGroup::Healthz as usize]
            .total
            .load(Ordering::Relaxed)
            + self.counters.groups[RouteGroup::Static as usize]
                .total
                .load(Ordering::Relaxed);

        let cur_2xx = self.counters.inbound_2xx.load(Ordering::Relaxed);
        let cur_3xx = self.counters.inbound_3xx.load(Ordering::Relaxed);
        let cur_4xx = self.counters.inbound_4xx.load(Ordering::Relaxed);
        let cur_5xx = self.counters.inbound_5xx.load(Ordering::Relaxed);
        let cur_in_rx = self.counters.inbound_req_bytes.load(Ordering::Relaxed);
        let cur_in_tx = self.counters.inbound_resp_bytes.load(Ordering::Relaxed);

        let cur_out_total = self.counters.outbound_total.load(Ordering::Relaxed);
        let cur_out_2xx = self.counters.outbound_2xx.load(Ordering::Relaxed);
        let cur_out_429 = self.counters.outbound_429.load(Ordering::Relaxed);
        let cur_out_err = self.counters.outbound_4xx.load(Ordering::Relaxed)
            + self.counters.outbound_5xx.load(Ordering::Relaxed);
        let cur_out_conn_err = self.counters.outbound_conn_err.load(Ordering::Relaxed);
        let cur_out_sse_int = self
            .counters
            .outbound_sse_interrupted
            .load(Ordering::Relaxed);
        let cur_out_tx = self.counters.outbound_req_bytes.load(Ordering::Relaxed);
        let cur_out_rx = self.counters.outbound_resp_bytes.load(Ordering::Relaxed);

        let routing_us_total = self.counters.routing_us_sum.load(Ordering::Relaxed);
        let routing_cnt_total = self.counters.routing_count.load(Ordering::Relaxed);
        let prep_us_total = self.counters.prep_us_sum.load(Ordering::Relaxed);
        let prep_cnt_total = self.counters.prep_count.load(Ordering::Relaxed);

        let cur_script_calls = script_stats.on_request_calls + script_stats.on_billing_calls;
        let cur_script_errs = script_stats.on_request_errors + script_stats.on_billing_errors;
        let cur_redis_hits = redis_stats.hits;
        let cur_redis_misses = redis_stats.misses;
        let cur_redis_writes = redis_stats.writes;
        let cur_redis_errors = redis_stats.errors;
        let cur_redis_lat_sum = redis_stats.latency_us_sum;
        let cur_redis_lat_cnt = redis_stats.latency_count;

        #[allow(clippy::cast_precision_loss)]
        let dt = FINE_INTERVAL_SECS as f64;
        let p = &guard.prev;

        let delta_redis_lat_cnt = cur_redis_lat_cnt.saturating_sub(p.redis_latency_count);
        #[allow(clippy::cast_precision_loss)]
        let redis_avg_latency_ms = if delta_redis_lat_cnt > 0 {
            cur_redis_lat_sum.saturating_sub(p.redis_latency_us_sum) as f64
                / (delta_redis_lat_cnt as f64 * 1000.0)
        } else {
            0.0
        };

        let delta_routing_cnt = routing_cnt_total.saturating_sub(p.routing_count);
        let delta_prep_cnt = prep_cnt_total.saturating_sub(p.prep_count);
        #[allow(clippy::cast_precision_loss)]
        let avg_routing_ms = if delta_routing_cnt > 0 {
            routing_us_total.saturating_sub(p.routing_us_sum) as f64
                / (delta_routing_cnt as f64 * 1000.0)
        } else {
            0.0
        };
        #[allow(clippy::cast_precision_loss)]
        let avg_prep_ms = if delta_prep_cnt > 0 {
            prep_us_total.saturating_sub(p.prep_us_sum) as f64 / (delta_prep_cnt as f64 * 1000.0)
        } else {
            0.0
        };

        let tz_offset = crate::db::timezone_offset_secs(&state.config.ui.timezone);
        let local_label = (Utc::now() + chrono::Duration::seconds(i64::from(tz_offset)))
            .format("%H:%M:%S")
            .to_string();

        #[allow(clippy::cast_precision_loss)]
        let sample = RuntimeSample {
            label: local_label,
            rss_mb: proc_metrics.rss_bytes as f64 / (1024.0 * 1024.0),
            peak_rss_mb: proc_metrics.peak_rss_bytes as f64 / (1024.0 * 1024.0),
            cgroup_mb: proc_metrics
                .cgroup_memory_bytes
                .map(|b| b as f64 / (1024.0 * 1024.0)),
            cpu_percent: proc_metrics.cpu_percent,
            open_fds: proc_metrics.open_fds,
            threads: proc_metrics.threads,
            inbound_inflight: self.counters.inbound_inflight.load(Ordering::Relaxed),
            active_sse_streams: self.counters.active_sse_streams.load(Ordering::Relaxed),
            outbound_inflight: self.counters.outbound_inflight.load(Ordering::Relaxed),
            inbound_rps: cur_total.saturating_sub(p.inbound_total) as f64 / dt,
            inbound_proxy_rps: cur_proxy.saturating_sub(p.inbound_proxy) as f64 / dt,
            inbound_api_rps: cur_api.saturating_sub(p.inbound_api) as f64 / dt,
            inbound_other_rps: cur_other.saturating_sub(p.inbound_other) as f64 / dt,
            inbound_2xx: cur_2xx.saturating_sub(p.inbound_2xx),
            inbound_3xx: cur_3xx.saturating_sub(p.inbound_3xx),
            inbound_4xx: cur_4xx.saturating_sub(p.inbound_4xx),
            inbound_5xx: cur_5xx.saturating_sub(p.inbound_5xx),
            inbound_rx_bps: cur_in_rx.saturating_sub(p.inbound_req_bytes) as f64 / dt,
            inbound_tx_bps: cur_in_tx.saturating_sub(p.inbound_resp_bytes) as f64 / dt,
            outbound_rps: cur_out_total.saturating_sub(p.outbound_total) as f64 / dt,
            outbound_2xx: cur_out_2xx.saturating_sub(p.outbound_2xx),
            outbound_429: cur_out_429.saturating_sub(p.outbound_429),
            outbound_err: cur_out_err.saturating_sub(p.outbound_err),
            outbound_conn_err: cur_out_conn_err.saturating_sub(p.outbound_conn_err),
            outbound_sse_interrupted: cur_out_sse_int.saturating_sub(p.outbound_sse_interrupted),
            outbound_tx_bps: cur_out_tx.saturating_sub(p.outbound_req_bytes) as f64 / dt,
            outbound_rx_bps: cur_out_rx.saturating_sub(p.outbound_resp_bytes) as f64 / dt,
            avg_routing_ms,
            avg_prep_ms,
            pg_active,
            pg_idle,
            log_queue_depth: log_stats.queue_depth,
            log_persisted_rps: log_stats.persisted.saturating_sub(p.log_persisted) as f64 / dt,
            script_calls_rps: cur_script_calls.saturating_sub(p.script_calls) as f64 / dt,
            script_errors: cur_script_errs.saturating_sub(p.script_errors),
            redis_hits_rps: cur_redis_hits.saturating_sub(p.redis_hits) as f64 / dt,
            redis_misses_rps: cur_redis_misses.saturating_sub(p.redis_misses) as f64 / dt,
            redis_writes_rps: cur_redis_writes.saturating_sub(p.redis_writes) as f64 / dt,
            redis_errors: cur_redis_errors.saturating_sub(p.redis_errors),
            redis_avg_latency_ms,
        };

        guard.prev = PrevSnapshot {
            inbound_total: cur_total,
            inbound_proxy: cur_proxy,
            inbound_api: cur_api,
            inbound_other: cur_other,
            inbound_2xx: cur_2xx,
            inbound_3xx: cur_3xx,
            inbound_4xx: cur_4xx,
            inbound_5xx: cur_5xx,
            inbound_req_bytes: cur_in_rx,
            inbound_resp_bytes: cur_in_tx,
            outbound_total: cur_out_total,
            outbound_2xx: cur_out_2xx,
            outbound_429: cur_out_429,
            outbound_err: cur_out_err,
            outbound_conn_err: cur_out_conn_err,
            outbound_sse_interrupted: cur_out_sse_int,
            outbound_req_bytes: cur_out_tx,
            outbound_resp_bytes: cur_out_rx,
            routing_us_sum: routing_us_total,
            routing_count: routing_cnt_total,
            prep_us_sum: prep_us_total,
            prep_count: prep_cnt_total,
            script_calls: cur_script_calls,
            script_errors: cur_script_errs,
            log_persisted: log_stats.persisted,
            redis_hits: cur_redis_hits,
            redis_misses: cur_redis_misses,
            redis_writes: cur_redis_writes,
            redis_errors: cur_redis_errors,
            redis_latency_us_sum: cur_redis_lat_sum,
            redis_latency_count: cur_redis_lat_cnt,
        };

        if guard.fine.len() >= FINE_CAPACITY {
            guard.fine.pop_front();
        }
        guard.fine.push_back(sample.clone());

        guard.coarse_acc.push(sample);
        if guard.coarse_acc.len() >= COARSE_STRIDE {
            let agg = aggregate_coarse_samples(&guard.coarse_acc);
            guard.coarse_acc.clear();
            if guard.coarse.len() >= COARSE_CAPACITY {
                guard.coarse.pop_front();
            }
            guard.coarse.push_back(agg);
        }
    }

    /// Builds the full `/api/v1/stats/monitoring/runtime` response for `window`.
    #[allow(clippy::too_many_lines)]
    #[must_use]
    pub fn build_response(&self, state: &AppState, window: &str) -> RuntimeMonitoringResponse {
        let (window_key, interval_secs, samples, proc_metrics) = {
            let mut guard = self
                .buffer
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if guard.last_proc.rss_bytes == 0 {
                let fresh = {
                    let buf = &mut *guard;
                    probe_process_metrics(buf.sys.as_mut(), &mut buf.peak_rss)
                };
                guard.last_proc = fresh;
            }
            let proc_copy = guard.last_proc.clone();
            match window {
                "5m" => {
                    let take = 60usize;
                    let start = guard.fine.len().saturating_sub(take);
                    (
                        "5m".to_string(),
                        FINE_INTERVAL_SECS,
                        guard.fine.iter().skip(start).cloned().collect::<Vec<_>>(),
                        proc_copy,
                    )
                }
                "1h" => (
                    "1h".to_string(),
                    FINE_INTERVAL_SECS,
                    guard.fine.iter().cloned().collect::<Vec<_>>(),
                    proc_copy,
                ),
                "6h" => {
                    let take = 360usize;
                    let start = guard.coarse.len().saturating_sub(take);
                    (
                        "6h".to_string(),
                        FINE_INTERVAL_SECS * COARSE_STRIDE as u64,
                        guard.coarse.iter().skip(start).cloned().collect::<Vec<_>>(),
                        proc_copy,
                    )
                }
                "24h" => (
                    "24h".to_string(),
                    FINE_INTERVAL_SECS * COARSE_STRIDE as u64,
                    guard.coarse.iter().cloned().collect::<Vec<_>>(),
                    proc_copy,
                ),
                _ => {
                    let take = 180usize;
                    let start = guard.fine.len().saturating_sub(take);
                    (
                        "15m".to_string(),
                        FINE_INTERVAL_SECS,
                        guard.fine.iter().skip(start).cloned().collect::<Vec<_>>(),
                        proc_copy,
                    )
                }
            }
        };

        let latest = samples.last();
        let log_stats = state
            .log_writer
            .as_ref()
            .map_or_default(crate::db::LogWriterHandle::stats);
        let script_stats = state.engine.runtime_stats();
        let redis_stats = state
            .redis
            .as_ref()
            .map_or_default(crate::redis_store::RedisStore::stats);
        let redis_reads = redis_stats.hits + redis_stats.misses;
        #[allow(clippy::cast_precision_loss)]
        let redis_hit_rate = if redis_reads > 0 {
            (redis_stats.hits as f64) * 100.0 / (redis_reads as f64)
        } else {
            0.0
        };
        #[allow(clippy::cast_precision_loss)]
        let redis_last_latency_ms = redis_stats.last_latency_us as f64 / 1000.0;
        let (mc_endpoints, mc_samples) = state.metrics.stats();
        let (pg_size, pg_idle) = state.db_pool.as_ref().map_or((0, 0), |p| {
            (p.size(), u32::try_from(p.num_idle()).unwrap_or(0))
        });
        let catalog_revision = state.catalog.load().revision();

        let snapshot = RuntimeSnapshot {
            uptime_secs: self.started_at.elapsed().as_secs(),
            os: std::env::consts::OS,
            rss_bytes: proc_metrics.rss_bytes,
            peak_rss_bytes: proc_metrics.peak_rss_bytes,
            virtual_bytes: proc_metrics.virtual_bytes,
            system_total_bytes: proc_metrics.system_total_bytes,
            system_used_bytes: proc_metrics.system_used_bytes,
            cgroup_memory_bytes: proc_metrics.cgroup_memory_bytes,
            cgroup_limit_bytes: proc_metrics.cgroup_limit_bytes,
            cpu_percent: proc_metrics.cpu_percent,
            open_fds: proc_metrics.open_fds,
            threads: proc_metrics.threads,
            inbound_inflight: self.counters.inbound_inflight.load(Ordering::Relaxed),
            active_sse_streams: self.counters.active_sse_streams.load(Ordering::Relaxed),
            outbound_inflight: self.counters.outbound_inflight.load(Ordering::Relaxed),
            current_inbound_rps: latest.map_or(0.0, |s| s.inbound_rps),
            current_outbound_rps: latest.map_or(0.0, |s| s.outbound_rps),
            current_inbound_rx_bps: latest.map_or(0.0, |s| s.inbound_rx_bps),
            current_inbound_tx_bps: latest.map_or(0.0, |s| s.inbound_tx_bps),
            current_outbound_tx_bps: latest.map_or(0.0, |s| s.outbound_tx_bps),
            current_outbound_rx_bps: latest.map_or(0.0, |s| s.outbound_rx_bps),
            pg_pool_size: pg_size,
            pg_pool_idle: pg_idle,
            pg_pool_max: state.config.database.max_connections,
            log_queue_depth: log_stats.queue_depth,
            log_queue_capacity: log_stats.queue_capacity,
            log_enqueued: log_stats.enqueued,
            log_persisted: log_stats.persisted,
            log_retries: log_stats.retries,
            log_dropped: log_stats.dropped,
            metrics_cache_endpoints: mc_endpoints,
            metrics_cache_samples: mc_samples,
            catalog_revision,
            script_on_request_calls: script_stats.on_request_calls,
            script_on_request_errors: script_stats.on_request_errors,
            script_on_billing_calls: script_stats.on_billing_calls,
            script_on_billing_errors: script_stats.on_billing_errors,
            script_http_calls: script_stats.http_calls,
            script_http_cache_hits: script_stats.http_cache_hits,
            script_http_singleflight: script_stats.http_singleflight_coalesced,
            script_http_ssrf_blocked: script_stats.http_ssrf_blocked,
            script_http_errors: script_stats.http_errors,
            script_http_cache_entries: script_stats.http_cache_entries,
            redis_enabled: state.redis.is_some(),
            redis_connected: redis_stats.connected,
            redis_ops_total: redis_stats.ops_total,
            redis_hits: redis_stats.hits,
            redis_misses: redis_stats.misses,
            redis_writes: redis_stats.writes,
            redis_errors: redis_stats.errors,
            redis_last_latency_ms,
            redis_hit_rate,
        };

        let mut channels = Vec::with_capacity(RouteGroup::COUNT + 2);
        for grp in RouteGroup::all() {
            let (key, label) = grp.meta();
            let c = &self.counters.groups[grp as usize];
            let completed = c.completed_count.load(Ordering::Relaxed);
            #[allow(clippy::cast_precision_loss)]
            let avg_duration_ms = if completed > 0 {
                c.duration_us_sum.load(Ordering::Relaxed) as f64 / (completed as f64 * 1000.0)
            } else {
                0.0
            };
            channels.push(HttpChannelRow {
                key: key.to_string(),
                label: label.to_string(),
                direction: "inbound",
                total_requests: c.total.load(Ordering::Relaxed),
                inflight: c.inflight.load(Ordering::Relaxed),
                s2xx: c.s2xx.load(Ordering::Relaxed),
                s4xx: c.s4xx.load(Ordering::Relaxed),
                s5xx_or_err: c.s5xx.load(Ordering::Relaxed),
                avg_duration_ms,
                rx_bytes: c.req_bytes.load(Ordering::Relaxed),
                tx_bytes: c.resp_bytes.load(Ordering::Relaxed),
            });
        }

        let out_completed = self
            .counters
            .outbound_completed_count
            .load(Ordering::Relaxed);
        #[allow(clippy::cast_precision_loss)]
        let out_avg_ms = if out_completed > 0 {
            self.counters
                .outbound_duration_us_sum
                .load(Ordering::Relaxed) as f64
                / (out_completed as f64 * 1000.0)
        } else {
            0.0
        };
        channels.push(HttpChannelRow {
            key: "proxy_outbound".to_string(),
            label: "上游模型转发 (Proxy Outbound)".to_string(),
            direction: "outbound",
            total_requests: self.counters.outbound_total.load(Ordering::Relaxed),
            inflight: self.counters.outbound_inflight.load(Ordering::Relaxed),
            s2xx: self.counters.outbound_2xx.load(Ordering::Relaxed),
            s4xx: self.counters.outbound_429.load(Ordering::Relaxed)
                + self.counters.outbound_4xx.load(Ordering::Relaxed),
            s5xx_or_err: self.counters.outbound_5xx.load(Ordering::Relaxed)
                + self.counters.outbound_conn_err.load(Ordering::Relaxed),
            avg_duration_ms: out_avg_ms,
            rx_bytes: self.counters.outbound_resp_bytes.load(Ordering::Relaxed),
            tx_bytes: self.counters.outbound_req_bytes.load(Ordering::Relaxed),
        });
        channels.push(HttpChannelRow {
            key: "script_http".to_string(),
            label: "脚本外部联网 (linguist.http)".to_string(),
            direction: "outbound",
            total_requests: script_stats.http_calls,
            inflight: 0,
            s2xx: script_stats
                .http_calls
                .saturating_sub(script_stats.http_errors),
            s4xx: script_stats.http_ssrf_blocked,
            s5xx_or_err: script_stats.http_errors,
            avg_duration_ms: 0.0,
            rx_bytes: 0,
            tx_bytes: 0,
        });

        RuntimeMonitoringResponse {
            window: window_key,
            interval_secs,
            snapshot,
            channels,
            samples,
        }
    }
}

/// Spawns the background 5-second runtime metrics sampler task.
pub fn start_sampler(state: &AppState) {
    let weak_state = state.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(FINE_INTERVAL_SECS));
        loop {
            ticker.tick().await;
            weak_state.runtime.collect_sample(&weak_state);
        }
    });
}

/// Aggregates 12 fine samples into a single 60-second coarse sample.
fn aggregate_coarse_samples(slice: &[RuntimeSample]) -> RuntimeSample {
    let n = slice.len().max(1);
    #[allow(clippy::cast_precision_loss)]
    let nf = n as f64;
    let last = slice.last().cloned().unwrap_or_else(|| RuntimeSample {
        label: String::new(),
        rss_mb: 0.0,
        peak_rss_mb: 0.0,
        cgroup_mb: None,
        cpu_percent: 0.0,
        open_fds: None,
        threads: None,
        inbound_inflight: 0,
        active_sse_streams: 0,
        outbound_inflight: 0,
        inbound_rps: 0.0,
        inbound_proxy_rps: 0.0,
        inbound_api_rps: 0.0,
        inbound_other_rps: 0.0,
        inbound_2xx: 0,
        inbound_3xx: 0,
        inbound_4xx: 0,
        inbound_5xx: 0,
        inbound_rx_bps: 0.0,
        inbound_tx_bps: 0.0,
        outbound_rps: 0.0,
        outbound_2xx: 0,
        outbound_429: 0,
        outbound_err: 0,
        outbound_conn_err: 0,
        outbound_sse_interrupted: 0,
        outbound_tx_bps: 0.0,
        outbound_rx_bps: 0.0,
        avg_routing_ms: 0.0,
        avg_prep_ms: 0.0,
        pg_active: 0,
        pg_idle: 0,
        log_queue_depth: 0,
        log_persisted_rps: 0.0,
        script_calls_rps: 0.0,
        script_errors: 0,
        redis_hits_rps: 0.0,
        redis_misses_rps: 0.0,
        redis_writes_rps: 0.0,
        redis_errors: 0,
        redis_avg_latency_ms: 0.0,
    });
    let label = last.label.get(..5).unwrap_or(&last.label).to_string();

    RuntimeSample {
        label,
        rss_mb: slice.iter().map(|s| s.rss_mb).sum::<f64>() / nf,
        peak_rss_mb: slice.iter().map(|s| s.peak_rss_mb).fold(0.0, f64::max),
        cgroup_mb: last.cgroup_mb,
        cpu_percent: slice.iter().map(|s| s.cpu_percent).sum::<f64>() / nf,
        open_fds: slice.iter().filter_map(|s| s.open_fds).max(),
        threads: last.threads,
        inbound_inflight: slice.iter().map(|s| s.inbound_inflight).max().unwrap_or(0),
        active_sse_streams: slice
            .iter()
            .map(|s| s.active_sse_streams)
            .max()
            .unwrap_or(0),
        outbound_inflight: slice.iter().map(|s| s.outbound_inflight).max().unwrap_or(0),
        inbound_rps: slice.iter().map(|s| s.inbound_rps).sum::<f64>() / nf,
        inbound_proxy_rps: slice.iter().map(|s| s.inbound_proxy_rps).sum::<f64>() / nf,
        inbound_api_rps: slice.iter().map(|s| s.inbound_api_rps).sum::<f64>() / nf,
        inbound_other_rps: slice.iter().map(|s| s.inbound_other_rps).sum::<f64>() / nf,
        inbound_2xx: slice.iter().map(|s| s.inbound_2xx).sum(),
        inbound_3xx: slice.iter().map(|s| s.inbound_3xx).sum(),
        inbound_4xx: slice.iter().map(|s| s.inbound_4xx).sum(),
        inbound_5xx: slice.iter().map(|s| s.inbound_5xx).sum(),
        inbound_rx_bps: slice.iter().map(|s| s.inbound_rx_bps).sum::<f64>() / nf,
        inbound_tx_bps: slice.iter().map(|s| s.inbound_tx_bps).sum::<f64>() / nf,
        outbound_rps: slice.iter().map(|s| s.outbound_rps).sum::<f64>() / nf,
        outbound_2xx: slice.iter().map(|s| s.outbound_2xx).sum(),
        outbound_429: slice.iter().map(|s| s.outbound_429).sum(),
        outbound_err: slice.iter().map(|s| s.outbound_err).sum(),
        outbound_conn_err: slice.iter().map(|s| s.outbound_conn_err).sum(),
        outbound_sse_interrupted: slice.iter().map(|s| s.outbound_sse_interrupted).sum(),
        outbound_tx_bps: slice.iter().map(|s| s.outbound_tx_bps).sum::<f64>() / nf,
        outbound_rx_bps: slice.iter().map(|s| s.outbound_rx_bps).sum::<f64>() / nf,
        avg_routing_ms: slice.iter().map(|s| s.avg_routing_ms).sum::<f64>() / nf,
        avg_prep_ms: slice.iter().map(|s| s.avg_prep_ms).sum::<f64>() / nf,
        pg_active: last.pg_active,
        pg_idle: last.pg_idle,
        log_queue_depth: slice.iter().map(|s| s.log_queue_depth).max().unwrap_or(0),
        log_persisted_rps: slice.iter().map(|s| s.log_persisted_rps).sum::<f64>() / nf,
        script_calls_rps: slice.iter().map(|s| s.script_calls_rps).sum::<f64>() / nf,
        script_errors: slice.iter().map(|s| s.script_errors).sum(),
        redis_hits_rps: slice.iter().map(|s| s.redis_hits_rps).sum::<f64>() / nf,
        redis_misses_rps: slice.iter().map(|s| s.redis_misses_rps).sum::<f64>() / nf,
        redis_writes_rps: slice.iter().map(|s| s.redis_writes_rps).sum::<f64>() / nf,
        redis_errors: slice.iter().map(|s| s.redis_errors).sum(),
        redis_avg_latency_ms: slice.iter().map(|s| s.redis_avg_latency_ms).sum::<f64>() / nf,
    }
}

/// Probes current process memory, CPU, cgroup limits, and open FDs.
fn probe_process_metrics(sys: Option<&mut System>, peak_rss: &mut u64) -> ProcessMetrics {
    let mut rss_bytes = 0u64;
    let mut virtual_bytes = 0u64;
    let mut cpu_percent = 0.0f64;
    let mut system_total_bytes = 0u64;
    let mut system_used_bytes = 0u64;

    if let Some(sys) = sys {
        sys.refresh_memory();
        system_total_bytes = sys.total_memory();
        system_used_bytes = sys.used_memory();
        if let Ok(pid) = sysinfo::get_current_pid() {
            sys.refresh_processes_specifics(
                ProcessesToUpdate::Some(&[pid]),
                true,
                ProcessRefreshKind::nothing().with_memory().with_cpu(),
            );
            if let Some(proc_info) = sys.process(pid) {
                rss_bytes = proc_info.memory();
                virtual_bytes = proc_info.virtual_memory();
                cpu_percent = f64::from(proc_info.cpu_usage());
            }
        }
    }

    *peak_rss = (*peak_rss).max(rss_bytes);

    let linux = probe_linux_procfs();
    if let Some(hwm) = linux.vm_hwm {
        *peak_rss = (*peak_rss).max(hwm);
    }

    ProcessMetrics {
        rss_bytes,
        peak_rss_bytes: *peak_rss,
        virtual_bytes,
        cpu_percent,
        system_total_bytes,
        system_used_bytes,
        cgroup_memory_bytes: linux.cgroup_cur,
        cgroup_limit_bytes: linux.cgroup_max,
        open_fds: linux.open_fds,
        threads: linux.threads,
    }
}

/// Supplemental Linux procfs/cgroup metrics.
#[derive(Debug, Default)]
struct LinuxProcfsStats {
    /// Current cgroup memory usage in bytes.
    cgroup_cur: Option<u64>,
    /// Finite cgroup memory limit in bytes.
    cgroup_max: Option<u64>,
    /// Open file descriptors in `/proc/self/fd`.
    open_fds: Option<u64>,
    /// Thread count from `/proc/self/status`.
    threads: Option<u64>,
    /// Peak RSS (`VmHWM`) from `/proc/self/status`.
    vm_hwm: Option<u64>,
}

/// Reads Linux container cgroup memory, open FD count, thread count, and `VmHWM` without `unsafe`.
#[cfg(target_os = "linux")]
fn probe_linux_procfs() -> LinuxProcfsStats {
    let cgroup_cur = read_u64_file("/sys/fs/cgroup/memory.current")
        .or_else(|| read_u64_file("/sys/fs/cgroup/memory/memory.usage_in_bytes"));
    let cgroup_max = read_u64_file("/sys/fs/cgroup/memory.max")
        .or_else(|| read_u64_file("/sys/fs/cgroup/memory/memory.limit_in_bytes"))
        .filter(|&v| v > 0 && v < (1u64 << 60));

    let open_fds = std::fs::read_dir("/proc/self/fd")
        .ok()
        .and_then(|rd| u64::try_from(rd.count()).ok());

    let mut threads = None;
    let mut vm_hwm = None;
    if let Ok(status_text) = std::fs::read_to_string("/proc/self/status") {
        for line in status_text.lines() {
            if let Some(rest) = line.strip_prefix("Threads:") {
                threads = rest.trim().parse::<u64>().ok();
            } else if let Some(rest) = line.strip_prefix("VmHWM:")
                && let Some(kb) = rest
                    .split_whitespace()
                    .next()
                    .and_then(|s| s.parse::<u64>().ok())
            {
                vm_hwm = Some(kb.saturating_mul(1024));
            }
        }
    }

    LinuxProcfsStats {
        cgroup_cur,
        cgroup_max,
        open_fds,
        threads,
        vm_hwm,
    }
}

/// Fallback for non-Linux targets (Windows/macOS).
#[cfg(not(target_os = "linux"))]
fn probe_linux_procfs() -> LinuxProcfsStats {
    LinuxProcfsStats::default()
}

/// Helper to read an unsigned 64-bit integer from a single-line sysfs or procfs file.
#[cfg(target_os = "linux")]
fn read_u64_file(path: &str) -> Option<u64> {
    std::fs::read_to_string(path)
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()
}

/// RAII guard decrementing inbound inflight and SSE counters when the response stream finishes/drops.
struct InboundStreamGuard {
    /// Shared runtime metrics collector.
    runtime: Arc<RuntimeMetrics>,
    /// Classified route group for this request.
    group: RouteGroup,
    /// Request arrival instant.
    started: Instant,
    /// Whether this response is an SSE stream.
    is_sse: bool,
    /// Whether completion has already been recorded.
    recorded_end: bool,
}

impl InboundStreamGuard {
    /// Decrements inflight gauges and records duration once.
    fn finish(&mut self) {
        if self.recorded_end {
            return;
        }
        self.recorded_end = true;
        self.runtime
            .counters
            .inbound_inflight
            .fetch_sub(1, Ordering::Relaxed);
        self.runtime.counters.groups[self.group as usize]
            .inflight
            .fetch_sub(1, Ordering::Relaxed);
        if self.is_sse {
            self.runtime
                .counters
                .active_sse_streams
                .fetch_sub(1, Ordering::Relaxed);
        }
        let dur_us = u64::try_from(self.started.elapsed().as_micros()).unwrap_or(u64::MAX);
        let grp = &self.runtime.counters.groups[self.group as usize];
        grp.duration_us_sum.fetch_add(dur_us, Ordering::Relaxed);
        grp.completed_count.fetch_add(1, Ordering::Relaxed);
    }
}

impl Drop for InboundStreamGuard {
    fn drop(&mut self) {
        self.finish();
    }
}

/// Zero-copy stream wrapper counting exact response bytes sent to downstream clients.
struct CountingResponseStream<S> {
    /// Wrapped Axum response byte stream.
    inner: Pin<Box<S>>,
    /// Drop guard tracking inflight and duration.
    guard: InboundStreamGuard,
}

impl<S> Stream for CountingResponseStream<S>
where
    S: Stream<Item = Result<Bytes, axum::Error>>,
{
    type Item = Result<Bytes, axum::Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        match self.inner.as_mut().poll_next(cx) {
            Poll::Ready(Some(Ok(chunk))) => {
                let len = u64::try_from(chunk.len()).unwrap_or(0);
                self.guard
                    .runtime
                    .counters
                    .inbound_resp_bytes
                    .fetch_add(len, Ordering::Relaxed);
                self.guard.runtime.counters.groups[self.guard.group as usize]
                    .resp_bytes
                    .fetch_add(len, Ordering::Relaxed);
                Poll::Ready(Some(Ok(chunk)))
            }
            Poll::Ready(None) => {
                self.guard.finish();
                Poll::Ready(None)
            }
            other => other,
        }
    }
}

/// Axum middleware recording inbound HTTP requests, status codes, durations, and byte throughput.
pub async fn inbound_http_middleware(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Response {
    let started = Instant::now();
    let group = RouteGroup::classify(req.uri().path());
    let req_bytes = req
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);

    let rt = Arc::clone(&state.runtime);
    rt.counters.inbound_total.fetch_add(1, Ordering::Relaxed);
    rt.counters.inbound_inflight.fetch_add(1, Ordering::Relaxed);
    rt.counters
        .inbound_req_bytes
        .fetch_add(req_bytes, Ordering::Relaxed);

    let grp = &rt.counters.groups[group as usize];
    grp.total.fetch_add(1, Ordering::Relaxed);
    grp.inflight.fetch_add(1, Ordering::Relaxed);
    grp.req_bytes.fetch_add(req_bytes, Ordering::Relaxed);

    let resp = next.run(req).await;
    let status = resp.status().as_u16();
    let is_sse = resp.status().is_success()
        && resp
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|ct| ct.to_ascii_lowercase().contains("text/event-stream"));

    if (200..300).contains(&status) {
        rt.counters.inbound_2xx.fetch_add(1, Ordering::Relaxed);
        grp.s2xx.fetch_add(1, Ordering::Relaxed);
    } else if (300..400).contains(&status) {
        rt.counters.inbound_3xx.fetch_add(1, Ordering::Relaxed);
    } else if (400..500).contains(&status) {
        rt.counters.inbound_4xx.fetch_add(1, Ordering::Relaxed);
        grp.s4xx.fetch_add(1, Ordering::Relaxed);
    } else {
        rt.counters.inbound_5xx.fetch_add(1, Ordering::Relaxed);
        grp.s5xx.fetch_add(1, Ordering::Relaxed);
    }

    if is_sse {
        rt.counters
            .active_sse_streams
            .fetch_add(1, Ordering::Relaxed);
    }

    let guard = InboundStreamGuard {
        runtime: rt,
        group,
        started,
        is_sse,
        recorded_end: false,
    };

    let (parts, body) = resp.into_parts();
    let wrapped = Body::from_stream(CountingResponseStream {
        inner: Box::pin(body.into_data_stream()),
        guard,
    });
    Response::from_parts(parts, wrapped)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_group_classifies_all_gateway_paths() {
        assert_eq!(
            RouteGroup::classify("/model/coding/v1/chat/completions"),
            RouteGroup::ProxyChat
        );
        assert_eq!(
            RouteGroup::classify("/model/coding/v1/models"),
            RouteGroup::ProxyModels
        );
        assert_eq!(
            RouteGroup::classify("/api/v1/stats/monitoring/runtime"),
            RouteGroup::StatsApi
        );
        assert_eq!(
            RouteGroup::classify("/api/v1/catalog/providers"),
            RouteGroup::AdminApi
        );
        assert_eq!(RouteGroup::classify("/auth/login"), RouteGroup::Auth);
        assert_eq!(RouteGroup::classify("/healthz"), RouteGroup::Healthz);
        assert_eq!(RouteGroup::classify("/assets/app.js"), RouteGroup::Static);
    }
}
