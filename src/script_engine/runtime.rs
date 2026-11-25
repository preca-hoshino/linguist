//! Non-blocking `LocalSet` Boa JS runtime pool, CPU/IO dual-budget enforcement,
//! `rust_decimal` billing helpers, and SSRF-guarded Singleflight `linguist.http`.

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::net::{IpAddr, SocketAddr};
use std::rc::Rc;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context as AnyhowContext, Result, anyhow, bail};
use boa_engine::builtins::promise::PromiseState;
use boa_engine::job::{FutureJob, JobQueue, NativeJob};
use boa_engine::object::ObjectInitializer;
use boa_engine::object::builtins::JsPromise;
use boa_engine::property::Attribute;
use boa_engine::{
    Context, JsArgs, JsNativeError, JsResult, JsValue, NativeFunction, Source, js_string,
};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, oneshot, watch};

use crate::config::ScriptEngineConfig;
use crate::models::{CompiledScriptUnit, EntityInfo, ProviderInfo, ScriptContext};
use crate::script_engine::compiler::host_hooks_for_mb;

/// Maximum response body size accepted by `linguist.http` (1 MiB).
const MAX_HTTP_BODY_BYTES: usize = 1024 * 1024;

/// Cost breakdown bucket category aligned with `monitoring_db` and `DataMonitoringPage`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum CostItemKind {
    /// Prompt/input token cost.
    Input,
    /// Completion/output token cost.
    Output,
    /// Cache read token cost.
    CacheRead,
    /// Cache write/creation token cost.
    CacheWrite,
    /// Storage, per-request, flat total, or miscellaneous cost.
    #[default]
    Other,
}

impl CostItemKind {
    /// Parses a string kind from JS (`"input"`, `"output"`, `"cache_read"`, `"cache_write"`, `"other"`).
    fn from_js_str(raw: &str) -> Self {
        match raw.trim() {
            "input" => Self::Input,
            "output" => Self::Output,
            "cache_read" | "cacheRead" => Self::CacheRead,
            "cache_write" | "cacheWrite" => Self::CacheWrite,
            _ => Self::Other,
        }
    }
}

/// Single line item emitted into `b.draft` by `onBilling` scripts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BillingLineItem {
    /// Human-readable item description.
    pub label: String,
    /// Exact decimal amount string.
    pub amount: String,
    /// Cost bucket classification.
    pub kind: CostItemKind,
    /// Optional quantity label (e.g. `"1200 tok"`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quantity: Option<String>,
    /// Optional unit price label.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit_price: Option<String>,
}

/// Optional Token usage overrides submitted via `b.draft.overrideUsage(...)`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageOverride {
    /// Overridden input tokens.
    pub input_tokens: Option<i64>,
    /// Overridden output tokens (triggers automatic `decode_tps` / `e2e_tps` recalculation).
    pub output_tokens: Option<i64>,
    /// Overridden cache read tokens.
    pub cache_read_tokens: Option<i64>,
    /// Overridden cache creation tokens.
    pub cache_creation_tokens: Option<i64>,
    /// Overridden reasoning tokens.
    pub reasoning_tokens: Option<i64>,
    /// Additional or overridden extra token counters.
    pub extra_tokens: Option<BTreeMap<String, i64>>,
}

/// Mutable draft state mutated sequentially across `Provider` -> `Model` `onBilling` scripts.
#[derive(Debug, Clone, Default)]
struct DraftBuffer {
    /// Target currency code (3 uppercase ASCII letters).
    currency: Option<String>,
    /// Explicit billing status (`"priced"`, `"estimated"`, `"free"`, `"unpriced"`).
    status: Option<String>,
    /// Whether `b.draft.freeze()` was called.
    frozen: bool,
    /// Ordered line items.
    items: Vec<BillingLineItem>,
    /// Custom metadata map.
    meta: Map<String, Value>,
    /// Optional token overrides.
    usage_override: Option<UsageOverride>,
}

/// Input payload serialized into `BillingContext` for `onBilling` scripts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BillingInput {
    /// Request start timestamp (ISO 8601 UTC).
    pub request_started_at_utc: String,
    /// Request completion timestamp (ISO 8601 UTC).
    pub completed_at_utc: String,
    /// 1-based attempt number.
    pub attempt: i16,
    /// Upstream HTTP status code.
    pub status_code: i32,
    /// Whether the request was streaming.
    pub is_stream: bool,
    /// Whether the stream was interrupted early.
    pub interrupted: bool,
    /// Consume-side project descriptor.
    pub project: EntityInfo,
    /// Consume-side call model descriptor.
    pub call_model: EntityInfo,
    /// Supply-side provider descriptor (includes `apiKey`).
    pub provider: ProviderInfo,
    /// Supply-side model descriptor.
    pub model: EntityInfo,
    /// Cross-stage `ctx.state` snapshot.
    pub state: Value,
    /// Measured request timings.
    pub timings: BillingTimings,
    /// Extracted token counters.
    pub tokens: BillingTokens,
    /// Full raw upstream `usage` object if present.
    pub raw_usage: Option<Value>,
}

/// Timing summary exposed as `b.timings`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BillingTimings {
    /// Time to first token in ms.
    pub ttft_ms: f64,
    /// Total duration in ms.
    pub total_duration_ms: f64,
    /// Net decode generation duration in ms.
    pub generation_duration_ms: f64,
    /// Net decode tokens per second.
    pub decode_tps: f64,
}

/// Token summary exposed as `b.tokens`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BillingTokens {
    /// Input tokens.
    pub input: i64,
    /// Output tokens.
    pub output: i64,
    /// Cache read tokens.
    pub cache_read: i64,
    /// Cache creation tokens.
    pub cache_creation: i64,
    /// Reasoning tokens.
    pub reasoning: i64,
    /// Total tokens.
    pub total: i64,
    /// Extra token counters.
    pub extra: BTreeMap<String, i64>,
    /// `"upstream_usage"` or `"fallback_estimated"`.
    pub source: String,
}

/// Finalized result returned by `execute_billing_chain`.
#[derive(Debug, Clone)]
pub struct BillingExecutionOutput {
    /// Exact original-currency total amount.
    pub amount: Option<Decimal>,
    /// Original 3-letter currency code.
    pub currency: Option<String>,
    /// Billing status (`"priced"`, `"estimated"`, `"free"`, `"unpriced"`, `"script_error"`).
    pub status: String,
    /// Structured JSONB details (`items`, `meta`, and 5 bucket totals).
    pub details: Value,
    /// Optional token overrides requested by script.
    pub usage_override: Option<UsageOverride>,
}

/// Cached HTTP response entry for `linguist.http` TTL cache.
#[derive(Debug, Clone)]
struct CachedHttpEntry {
    /// Expiration instant.
    expires_at: Instant,
    /// Cached JSON payload `{ status, body }`.
    payload: String,
}

/// Map of inflight HTTP requests keyed by cache key.
type InflightHttpMap = Mutex<HashMap<String, watch::Receiver<Option<Result<String, String>>>>>;

/// Thread-safe Singleflight + TTL memory cache for `linguist.http`.
#[derive(Debug, Default)]
struct HttpCache {
    /// Completed cached entries keyed by `cacheKey`.
    entries: Mutex<HashMap<String, CachedHttpEntry>>,
    /// Active inflight fetches keyed by `cacheKey`.
    inflight: InflightHttpMap,
}

impl HttpCache {
    /// Looks up a non-expired cached entry.
    fn get(&self, key: &str) -> Option<String> {
        let mut guard = self.entries.lock().ok()?;
        let entry = guard.get(key)?;
        if Instant::now() < entry.expires_at {
            return Some(entry.payload.clone());
        }
        guard.remove(key);
        None
    }

    /// Inserts a cached entry with `ttl_secs`.
    fn insert(&self, key: String, payload: String, ttl_secs: u64) {
        if ttl_secs == 0 {
            return;
        }
        if let Ok(mut guard) = self.entries.lock() {
            if guard.len() > 4096 {
                let now = Instant::now();
                guard.retain(|_, v| v.expires_at > now);
            }
            guard.insert(
                key,
                CachedHttpEntry {
                    expires_at: Instant::now() + Duration::from_secs(ttl_secs),
                    payload,
                },
            );
        }
    }
}

/// Shared HTTP client and cache context injected into worker threads.
#[derive(Debug, Clone)]
struct HttpContext {
    /// Shared pooled `reqwest::Client`.
    client: reqwest::Client,
    /// Shared Singleflight + TTL cache.
    cache: Arc<HttpCache>,
    /// Engine configuration (timeouts, SSRF rules).
    config: Arc<ScriptEngineConfig>,
}

/// Per-invocation mutable slot stored in thread-local map for native host callbacks.
struct HostInvocationSlot {
    /// Shared billing draft buffer (populated during `onBilling` runs).
    draft: Rc<RefCell<DraftBuffer>>,
    /// HTTP helper context.
    http: HttpContext,
    /// Remaining HTTP call budget for this invocation.
    http_calls_used: Rc<AtomicUsize>,
    /// Max HTTP calls permitted in this invocation.
    max_http_calls: usize,
    /// Default HTTP timeout in milliseconds.
    default_net_timeout_ms: u64,
    /// Whether `linguist.http` is enabled (disabled during compile-time).
    allow_network: bool,
}

thread_local! {
    /// Thread-local active invocation registry keyed by `slot_id`.
    static HOST_SLOTS: RefCell<HashMap<u64, HostInvocationSlot>> = RefCell::new(HashMap::new());
}

/// Next monotonic slot ID.
static NEXT_SLOT_ID: AtomicU64 = AtomicU64::new(1);

/// RAII guard removing a thread-local `HostInvocationSlot` on drop.
struct SlotGuard(u64);

impl Drop for SlotGuard {
    fn drop(&mut self) {
        HOST_SLOTS.with(|map| {
            map.borrow_mut().remove(&self.0);
        });
    }
}

/// Non-blocking `JobQueue` driving Boa Promises on a `tokio::task::LocalSet` while
/// tracking pure JS CPU execution time separately from awaited network IO.
struct TokioJobQueue {
    /// Queued synchronous microtasks / promise reactions.
    jobs: RefCell<VecDeque<NativeJob>>,
    /// Count of inflight `FutureJob`s spawned onto `LocalSet`.
    pending_futures: Cell<usize>,
    /// Sender for completed `FutureJob`s.
    tx: mpsc::UnboundedSender<NativeJob>,
    /// Receiver for completed `FutureJob`s.
    rx: tokio::sync::Mutex<mpsc::UnboundedReceiver<NativeJob>>,
    /// Accumulated JS CPU time.
    cpu_elapsed: Cell<Duration>,
    /// CPU time budget.
    cpu_limit: Duration,
    /// Flag set if CPU budget was exceeded.
    cpu_timed_out: Cell<bool>,
}

impl TokioJobQueue {
    /// Creates a new `TokioJobQueue` with the given CPU execution budget.
    fn new(cpu_limit: Duration) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        Self {
            jobs: RefCell::new(VecDeque::new()),
            pending_futures: Cell::new(0),
            tx,
            rx: tokio::sync::Mutex::new(rx),
            cpu_elapsed: Cell::new(Duration::ZERO),
            cpu_limit,
            cpu_timed_out: Cell::new(false),
        }
    }

    /// Adds synchronous CPU elapsed time and checks whether the budget was exceeded.
    fn record_cpu(&self, delta: Duration) -> bool {
        let total = self.cpu_elapsed.get().saturating_add(delta);
        self.cpu_elapsed.set(total);
        if total > self.cpu_limit {
            self.cpu_timed_out.set(true);
            true
        } else {
            false
        }
    }
}

impl JobQueue for TokioJobQueue {
    fn enqueue_promise_job(&self, job: NativeJob, _: &mut Context) {
        self.jobs.borrow_mut().push_back(job);
    }

    fn run_jobs(&self, context: &mut Context) {
        loop {
            let next = self.jobs.borrow_mut().pop_front();
            let Some(job) = next else {
                break;
            };
            let t0 = Instant::now();
            let res = job.call(context);
            if self.record_cpu(t0.elapsed()) || res.is_err() {
                self.jobs.borrow_mut().clear();
                return;
            }
        }
    }

    fn enqueue_future_job(&self, future: FutureJob, _: &mut Context) {
        self.pending_futures
            .set(self.pending_futures.get().saturating_add(1));
        let tx = self.tx.clone();
        tokio::task::spawn_local(async move {
            let job = future.await;
            let _ = tx.send(job);
        });
    }

    fn run_jobs_async<'a, 'ctx, 'fut>(
        &'a self,
        context: &'ctx mut Context,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + 'fut>>
    where
        'a: 'fut,
        'ctx: 'fut,
    {
        Box::pin(async move {
            loop {
                self.run_jobs(context);
                if self.cpu_timed_out.get() || self.pending_futures.get() == 0 {
                    break;
                }
                let next_job = {
                    let mut rx = self.rx.lock().await;
                    rx.recv().await
                };
                let Some(job) = next_job else {
                    break;
                };
                self.pending_futures
                    .set(self.pending_futures.get().saturating_sub(1));
                self.jobs.borrow_mut().push_back(job);
            }
        })
    }
}

/// Request sent to a `LocalSet` worker thread.
enum RuntimeJob {
    /// Execute one `CompiledScriptUnit::onRequest` against `ScriptContext`.
    ExecuteRequest {
        /// Pre-compiled JS factory source.
        js_code: String,
        /// Input context.
        input_ctx: Box<ScriptContext>,
        /// Completion channel.
        reply: oneshot::Sender<Result<ScriptContext>>,
    },
    /// Execute an ordered list of `onBilling` units against `BillingInput`.
    ExecuteBilling {
        /// Compiled units exporting `onBilling` (in `Provider` -> `Model` order).
        units: Vec<CompiledScriptUnit>,
        /// Billing context input.
        input: Box<BillingInput>,
        /// Completion channel.
        reply: oneshot::Sender<Result<BillingExecutionOutput>>,
    },
}

/// Pool of dedicated single-threaded `LocalSet` workers running `!Send` Boa VMs.
#[derive(Debug, Clone)]
pub struct ScriptRuntimePool {
    /// Round-robin worker senders.
    workers: Arc<Vec<mpsc::UnboundedSender<RuntimeJob>>>,
    /// Round-robin index.
    rr: Arc<AtomicUsize>,
}

impl ScriptRuntimePool {
    /// Spawns a pool of `LocalSet` Boa worker threads.
    #[must_use]
    pub fn new(config: Arc<ScriptEngineConfig>) -> Self {
        let count = std::thread::available_parallelism()
            .map_or(2, std::num::NonZeroUsize::get)
            .clamp(2, 4);

        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_millis(2500))
            .pool_max_idle_per_host(16)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        let http_ctx = HttpContext {
            client,
            cache: Arc::new(HttpCache::default()),
            config,
        };

        let mut workers = Vec::with_capacity(count);
        for idx in 0..count {
            let (tx, mut rx) = mpsc::unbounded_channel::<RuntimeJob>();
            let ctx_clone = http_ctx.clone();
            let _ = std::thread::Builder::new()
                .name(format!("linguist-js-{idx}"))
                .spawn(move || {
                    let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                    else {
                        return;
                    };
                    let local = tokio::task::LocalSet::new();
                    local.block_on(&rt, async move {
                        while let Some(job) = rx.recv().await {
                            let hc = ctx_clone.clone();
                            tokio::task::spawn_local(async move {
                                match job {
                                    RuntimeJob::ExecuteRequest {
                                        js_code,
                                        input_ctx,
                                        reply,
                                    } => {
                                        let res =
                                            run_request_unit_local(&js_code, &input_ctx, hc).await;
                                        let _ = reply.send(res);
                                    }
                                    RuntimeJob::ExecuteBilling {
                                        units,
                                        input,
                                        reply,
                                    } => {
                                        let res = run_billing_chain_local(&units, &input, hc).await;
                                        let _ = reply.send(res);
                                    }
                                }
                            });
                        }
                    });
                });
            workers.push(tx);
        }

        Self {
            workers: Arc::new(workers),
            rr: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// Executes a single `onRequest` unit asynchronously on a worker thread.
    ///
    /// # Errors
    /// Returns an error if the worker is unavailable, JS throws, or CPU/IO limits are exceeded.
    pub async fn execute_request_unit(
        &self,
        js_code: &str,
        input_ctx: &ScriptContext,
    ) -> Result<ScriptContext> {
        let idx = self.rr.fetch_add(1, Ordering::Relaxed) % self.workers.len();
        let (tx, rx) = oneshot::channel();
        self.workers[idx]
            .send(RuntimeJob::ExecuteRequest {
                js_code: js_code.to_string(),
                input_ctx: Box::new(input_ctx.clone()),
                reply: tx,
            })
            .map_err(|_| anyhow!("script worker pool channel closed"))?;
        rx.await
            .map_err(|_| anyhow!("script worker dropped request"))?
    }

    /// Executes an ordered `onBilling` chain (`Provider` -> `Model`) asynchronously.
    ///
    /// # Errors
    /// Returns an error if the worker is unavailable, JS throws, or output amounts are invalid.
    pub async fn execute_billing_chain(
        &self,
        units: &[CompiledScriptUnit],
        input: &BillingInput,
    ) -> Result<BillingExecutionOutput> {
        let idx = self.rr.fetch_add(1, Ordering::Relaxed) % self.workers.len();
        let (tx, rx) = oneshot::channel();
        self.workers[idx]
            .send(RuntimeJob::ExecuteBilling {
                units: units.to_vec(),
                input: Box::new(input.clone()),
                reply: tx,
            })
            .map_err(|_| anyhow!("script worker pool channel closed"))?;
        rx.await
            .map_err(|_| anyhow!("script worker dropped billing task"))?
    }
}

/// Runs a single `onRequest` module unit inside the current `LocalSet`.
async fn run_request_unit_local(
    js_code: &str,
    input_ctx: &ScriptContext,
    http: HttpContext,
) -> Result<ScriptContext> {
    let cpu_limit = Duration::from_millis(http.config.timeout_ms.max(1));
    let job_queue = Rc::new(TokioJobQueue::new(cpu_limit));
    let mut boa = boa_engine::context::ContextBuilder::new()
        .host_hooks(host_hooks_for_mb(http.config.memory_limit_mb))
        .job_queue(Rc::clone(&job_queue))
        .build()
        .map_err(|err| anyhow!("failed to initialize Boa JS context: {err}"))?;

    let limits = boa.runtime_limits_mut();
    limits.set_loop_iteration_limit(50_000);
    limits.set_recursion_limit(256);
    limits.set_stack_size_limit(8_192);

    let slot_id = NEXT_SLOT_ID.fetch_add(1, Ordering::Relaxed);
    let _guard = SlotGuard(slot_id);
    let slot = HostInvocationSlot {
        draft: Rc::new(RefCell::new(DraftBuffer::default())),
        http: http.clone(),
        http_calls_used: Rc::new(AtomicUsize::new(0)),
        max_http_calls: http.config.max_http_calls_per_stage,
        default_net_timeout_ms: http.config.net_timeout_ms.max(100),
        allow_network: true,
    };
    HOST_SLOTS.with(|map| {
        map.borrow_mut().insert(slot_id, slot);
    });

    register_linguist_globals(&mut boa, slot_id)?;

    let ctx_json = serde_json::to_value(input_ctx)
        .context("failed to serialize ScriptContext to JSON value")?;
    let ctx_val = JsValue::from_json(&ctx_json, &mut boa)
        .map_err(|err| anyhow!("failed to convert ScriptContext JSON into JS VM: {err}"))?;

    boa.register_global_property(
        js_string!("__linguist_input_ctx"),
        ctx_val,
        Attribute::all(),
    )
    .map_err(|err| anyhow!("failed to bind input ctx in JS VM: {err}"))?;

    let wrapper = format!(
        "{js_code}\n\
         const __linguist_mod = __linguist_module();\n\
         Promise.resolve(\n\
           typeof __linguist_mod.onRequest === 'function'\n\
             ? __linguist_mod.onRequest(__linguist_input_ctx)\n\
             : undefined\n\
         ).then((__ret) => (__ret && typeof __ret === 'object') ? __ret : __linguist_input_ctx);"
    );

    let t0 = Instant::now();
    let script = boa_engine::Script::parse(Source::from_bytes(wrapper.as_bytes()), None, &mut boa)
        .map_err(|err| anyhow!("script syntax error: {err}"))?;
    let promise_val = script
        .evaluate(&mut boa)
        .map_err(|err| anyhow!("script runtime error: {err}"))?;
    if job_queue.record_cpu(t0.elapsed()) {
        bail!(
            "script CPU execution exceeded {}ms budget",
            cpu_limit.as_millis()
        );
    }

    let final_val = resolve_js_promise(&mut boa, &job_queue, promise_val, cpu_limit).await?;
    let mut json_out = final_val
        .to_json(&mut boa)
        .map_err(|err| anyhow!("failed to extract ScriptContext JSON output: {err}"))?;
    normalize_whole_json_numbers(&mut json_out);

    let mut mutated: ScriptContext = serde_json::from_value(json_out)
        .context("script mutated ScriptContext into incompatible shape")?;
    enforce_readonly_fields(input_ctx, &mut mutated);
    Ok(mutated)
}

/// Runs an ordered chain of `onBilling` modules (`Provider` -> `Model`) sharing one `b.draft`.
async fn run_billing_chain_local(
    units: &[CompiledScriptUnit],
    input: &BillingInput,
    http: HttpContext,
) -> Result<BillingExecutionOutput> {
    let cpu_limit = Duration::from_millis(http.config.timeout_ms.max(1));
    let draft_rc = Rc::new(RefCell::new(DraftBuffer::default()));

    let slot_id = NEXT_SLOT_ID.fetch_add(1, Ordering::Relaxed);
    let _guard = SlotGuard(slot_id);
    let slot = HostInvocationSlot {
        draft: Rc::clone(&draft_rc),
        http: http.clone(),
        http_calls_used: Rc::new(AtomicUsize::new(0)),
        max_http_calls: http.config.max_http_calls_billing,
        default_net_timeout_ms: http.config.billing_net_timeout_ms.max(100),
        allow_network: true,
    };
    HOST_SLOTS.with(|map| {
        map.borrow_mut().insert(slot_id, slot);
    });

    for unit in units {
        if !unit.has_on_billing {
            continue;
        }
        if draft_rc.borrow().frozen {
            break;
        }

        let job_queue = Rc::new(TokioJobQueue::new(cpu_limit));
        let mut boa = boa_engine::context::ContextBuilder::new()
            .host_hooks(host_hooks_for_mb(http.config.memory_limit_mb))
            .job_queue(Rc::clone(&job_queue))
            .build()
            .map_err(|err| anyhow!("failed to initialize Boa billing VM: {err}"))?;

        let limits = boa.runtime_limits_mut();
        limits.set_loop_iteration_limit(50_000);
        limits.set_recursion_limit(256);
        limits.set_stack_size_limit(8_192);

        register_linguist_globals(&mut boa, slot_id)?;

        let input_json = serde_json::to_value(input).context("failed to serialize BillingInput")?;
        let b_val = JsValue::from_json(&input_json, &mut boa)
            .map_err(|err| anyhow!("failed to convert BillingInput into JS VM: {err}"))?;

        if let Some(obj) = b_val.as_object() {
            let draft_obj = build_draft_js_object(&mut boa, slot_id);
            obj.set(js_string!("draft"), draft_obj, false, &mut boa)
                .map_err(|err| anyhow!("failed to attach b.draft: {err}"))?;
        }

        boa.register_global_property(
            js_string!("__linguist_billing_ctx"),
            b_val,
            Attribute::all(),
        )
        .map_err(|err| anyhow!("failed to bind billing ctx: {err}"))?;

        let wrapper = format!(
            "{}\n\
             const __linguist_mod = __linguist_module();\n\
             Promise.resolve(\n\
               typeof __linguist_mod.onBilling === 'function'\n\
                 ? __linguist_mod.onBilling(__linguist_billing_ctx)\n\
                 : undefined\n\
             );",
            unit.js_code
        );

        let t0 = Instant::now();
        let script =
            boa_engine::Script::parse(Source::from_bytes(wrapper.as_bytes()), None, &mut boa)
                .map_err(|err| anyhow!("billing script '{}' syntax error: {err}", unit.id))?;
        let promise_val = script
            .evaluate(&mut boa)
            .map_err(|err| anyhow!("billing script '{}' runtime error: {err}", unit.id))?;
        if job_queue.record_cpu(t0.elapsed()) {
            bail!(
                "billing script '{}' exceeded {}ms CPU budget",
                unit.id,
                cpu_limit.as_millis()
            );
        }

        let _ = resolve_js_promise(&mut boa, &job_queue, promise_val, cpu_limit).await?;
    }

    let draft = draft_rc.borrow().clone();
    finalize_billing_draft(draft, input)
}

/// Awaits a `JsPromise` using `TokioJobQueue::run_jobs_async` and returns the fulfilled value.
async fn resolve_js_promise(
    boa: &mut Context,
    job_queue: &TokioJobQueue,
    promise_val: JsValue,
    cpu_limit: Duration,
) -> Result<JsValue> {
    boa.run_jobs_async().await;
    if job_queue.cpu_timed_out.get() {
        bail!(
            "script CPU execution exceeded {}ms budget",
            cpu_limit.as_millis()
        );
    }

    if let Some(obj) = promise_val.as_object()
        && let Ok(promise) = JsPromise::from_object(obj.clone())
    {
        return match promise.state() {
            PromiseState::Fulfilled(val) => Ok(val),
            PromiseState::Rejected(err_val) => {
                let msg = err_val.to_string(boa).map_or_else(
                    |_| "unknown JS rejection".to_string(),
                    |s| s.to_std_string_escaped(),
                );
                bail!("script rejected: {msg}")
            }
            PromiseState::Pending => bail!("script returned an unresolved Promise"),
        };
    }

    Ok(promise_val)
}

/// Finalizes the accumulated `DraftBuffer` into exact `Decimal` totals and 5-bucket details.
fn finalize_billing_draft(
    draft: DraftBuffer,
    input: &BillingInput,
) -> Result<BillingExecutionOutput> {
    let mut input_amt = Decimal::ZERO;
    let mut output_amt = Decimal::ZERO;
    let mut cache_read_amt = Decimal::ZERO;
    let mut cache_write_amt = Decimal::ZERO;
    let mut other_amt = Decimal::ZERO;
    let mut total_amt = Decimal::ZERO;

    for item in &draft.items {
        let amt = parse_non_negative_decimal(&item.amount).with_context(|| {
            format!(
                "invalid billing item '{}' amount '{}'",
                item.label, item.amount
            )
        })?;
        total_amt = total_amt
            .checked_add(amt)
            .ok_or_else(|| anyhow!("billing total overflow"))?;
        match item.kind {
            CostItemKind::Input => {
                input_amt = input_amt
                    .checked_add(amt)
                    .ok_or_else(|| anyhow!("input amount overflow"))?;
            }
            CostItemKind::Output => {
                output_amt = output_amt
                    .checked_add(amt)
                    .ok_or_else(|| anyhow!("output amount overflow"))?;
            }
            CostItemKind::CacheRead => {
                cache_read_amt = cache_read_amt
                    .checked_add(amt)
                    .ok_or_else(|| anyhow!("cache read amount overflow"))?;
            }
            CostItemKind::CacheWrite => {
                cache_write_amt = cache_write_amt
                    .checked_add(amt)
                    .ok_or_else(|| anyhow!("cache write amount overflow"))?;
            }
            CostItemKind::Other => {
                other_amt = other_amt
                    .checked_add(amt)
                    .ok_or_else(|| anyhow!("other amount overflow"))?;
            }
        }
    }

    let has_items = !draft.items.is_empty();
    let status = if let Some(explicit) = draft.status {
        explicit
    } else if !has_items {
        "unpriced".to_string()
    } else if input.tokens.source == "fallback_estimated" || input.interrupted {
        "estimated".to_string()
    } else {
        "priced".to_string()
    };

    let currency = draft.currency.map(|c| c.trim().to_ascii_uppercase());
    if let Some(curr) = &currency
        && (curr.len() != 3 || !curr.bytes().all(|b| b.is_ascii_uppercase()))
    {
        bail!("invalid billing currency '{curr}' (must be 3-letter ISO code)");
    }

    let amount = match status.as_str() {
        "unpriced" => None,
        "free" => Some(Decimal::ZERO),
        _ if has_items => {
            if currency.is_none() {
                bail!("billing items were added without calling b.draft.setCurrency(...)");
            }
            Some(total_amt)
        }
        _ => None,
    };

    let details = json!({
        "items": draft.items,
        "meta": draft.meta,
        "inputAmount": input_amt.normalize().to_string(),
        "outputAmount": output_amt.normalize().to_string(),
        "cacheReadAmount": cache_read_amt.normalize().to_string(),
        "cacheWriteAmount": cache_write_amt.normalize().to_string(),
        "otherAmount": other_amt.normalize().to_string(),
    });

    Ok(BillingExecutionOutput {
        amount,
        currency,
        status,
        details,
        usage_override: draft.usage_override,
    })
}

/// Registers the global `linguist` helper object and `__linguist_slot_id` inside Boa.
fn register_linguist_globals(boa: &mut Context, slot_id: u64) -> Result<()> {
    #[allow(clippy::cast_precision_loss)]
    boa.register_global_property(
        js_string!("__linguist_slot_id"),
        JsValue::new(slot_id as f64),
        Attribute::READONLY,
    )
    .map_err(|err| anyhow!("failed to register slot id: {err}"))?;

    let http_obj = ObjectInitializer::new(boa)
        .function(
            NativeFunction::from_copy_closure(|_this, args, ctx| js_http_fetch(args, ctx, true)),
            js_string!("fetchJson"),
            2,
        )
        .function(
            NativeFunction::from_copy_closure(|_this, args, ctx| js_http_fetch(args, ctx, false)),
            js_string!("fetchText"),
            2,
        )
        .build();

    let linguist_obj = ObjectInitializer::new(boa)
        .function(
            NativeFunction::from_copy_closure(|_this, args, ctx| js_cost_per_million(args, ctx)),
            js_string!("costPerMillion"),
            2,
        )
        .function(
            NativeFunction::from_copy_closure(|_this, args, ctx| js_dec_add(args, ctx)),
            js_string!("decAdd"),
            1,
        )
        .function(
            NativeFunction::from_copy_closure(|_this, args, ctx| js_dec_sub(args, ctx)),
            js_string!("decSub"),
            2,
        )
        .function(
            NativeFunction::from_copy_closure(|_this, args, ctx| js_dec_mul(args, ctx)),
            js_string!("decMul"),
            2,
        )
        .function(
            NativeFunction::from_copy_closure(|_this, args, ctx| js_tier_billing(args, ctx)),
            js_string!("tierBilling"),
            2,
        )
        .property(js_string!("http"), http_obj, Attribute::READONLY)
        .build();

    boa.register_global_property(js_string!("linguist"), linguist_obj, Attribute::READONLY)
        .map_err(|err| anyhow!("failed to register global linguist object: {err}"))?;

    Ok(())
}

/// Builds the `b.draft` object with native `BillingDraft` callbacks.
#[allow(clippy::too_many_lines)]
fn build_draft_js_object(boa: &mut Context, slot_id: u64) -> JsValue {
    let _ = slot_id;
    ObjectInitializer::new(boa)
        .function(
            NativeFunction::from_copy_closure(|_this, args, ctx| {
                let curr = args
                    .get_or_undefined(0)
                    .to_string(ctx)?
                    .to_std_string_escaped();
                with_draft(ctx, |d| d.currency = Some(curr))?;
                Ok(JsValue::undefined())
            }),
            js_string!("setCurrency"),
            1,
        )
        .function(
            NativeFunction::from_copy_closure(|_this, args, ctx| {
                let status = args
                    .get_or_undefined(0)
                    .to_string(ctx)?
                    .to_std_string_escaped();
                if !matches!(
                    status.as_str(),
                    "priced" | "estimated" | "free" | "unpriced"
                ) {
                    return Err(JsNativeError::typ()
                        .with_message("invalid billing status")
                        .into());
                }
                with_draft(ctx, |d| d.status = Some(status))?;
                Ok(JsValue::undefined())
            }),
            js_string!("setStatus"),
            1,
        )
        .function(
            NativeFunction::from_copy_closure(|_this, args, ctx| js_draft_add_item(args, ctx)),
            js_string!("addItem"),
            1,
        )
        .function(
            NativeFunction::from_copy_closure(|_this, args, ctx| {
                js_draft_add_typed(args, ctx, CostItemKind::Input)
            }),
            js_string!("addInput"),
            4,
        )
        .function(
            NativeFunction::from_copy_closure(|_this, args, ctx| {
                js_draft_add_typed(args, ctx, CostItemKind::Output)
            }),
            js_string!("addOutput"),
            4,
        )
        .function(
            NativeFunction::from_copy_closure(|_this, args, ctx| {
                js_draft_add_typed(args, ctx, CostItemKind::CacheRead)
            }),
            js_string!("addCacheRead"),
            4,
        )
        .function(
            NativeFunction::from_copy_closure(|_this, args, ctx| {
                js_draft_add_typed(args, ctx, CostItemKind::CacheWrite)
            }),
            js_string!("addCacheWrite"),
            4,
        )
        .function(
            NativeFunction::from_copy_closure(|_this, args, ctx| {
                js_draft_add_typed(args, ctx, CostItemKind::Other)
            }),
            js_string!("addOther"),
            4,
        )
        .function(
            NativeFunction::from_copy_closure(|_this, args, ctx| js_draft_set_total(args, ctx)),
            js_string!("setTotal"),
            3,
        )
        .function(
            NativeFunction::from_copy_closure(|_this, _args, ctx| {
                with_draft(ctx, |d| {
                    d.items.clear();
                    d.currency = None;
                    d.status = None;
                    d.meta.clear();
                })?;
                Ok(JsValue::undefined())
            }),
            js_string!("reset"),
            0,
        )
        .function(
            NativeFunction::from_copy_closure(|_this, _args, ctx| {
                with_draft(ctx, |d| d.frozen = true)?;
                Ok(JsValue::undefined())
            }),
            js_string!("freeze"),
            0,
        )
        .function(
            NativeFunction::from_copy_closure(|_this, args, ctx| {
                let key = args
                    .get_or_undefined(0)
                    .to_string(ctx)?
                    .to_std_string_escaped();
                let val = args.get_or_undefined(1).to_json(ctx)?;
                with_draft(ctx, |d| {
                    d.meta.insert(key, val);
                })?;
                Ok(JsValue::undefined())
            }),
            js_string!("setMeta"),
            2,
        )
        .function(
            NativeFunction::from_copy_closure(|_this, args, ctx| {
                js_draft_override_usage(args, ctx)
            }),
            js_string!("overrideUsage"),
            1,
        )
        .build()
        .into()
}

/// Reads `__linguist_slot_id` from the active Boa context.
fn active_slot_id(ctx: &mut Context) -> JsResult<u64> {
    let val = ctx
        .global_object()
        .get(js_string!("__linguist_slot_id"), ctx)?;
    let f = val
        .as_number()
        .ok_or_else(|| JsNativeError::typ().with_message("missing host slot id"))?;
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    Ok(f as u64)
}

/// Mutates the active `DraftBuffer` unless frozen.
fn with_draft<F>(ctx: &mut Context, f: F) -> JsResult<()>
where
    F: FnOnce(&mut DraftBuffer),
{
    let slot_id = active_slot_id(ctx)?;
    HOST_SLOTS.with(|map| {
        let map_ref = map.borrow();
        let slot = map_ref
            .get(&slot_id)
            .ok_or_else(|| JsNativeError::typ().with_message("expired host slot"))?;
        let mut draft = slot.draft.borrow_mut();
        if !draft.frozen {
            f(&mut draft);
        }
        Ok(())
    })
}

/// Implements `b.draft.addItem({ label, amount, kind?, quantity?, unitPrice? })`.
fn js_draft_add_item(args: &[JsValue], ctx: &mut Context) -> JsResult<JsValue> {
    let val = args.get_or_undefined(0).to_json(ctx)?;
    let obj = val
        .as_object()
        .ok_or_else(|| JsNativeError::typ().with_message("addItem expects an object"))?;
    let label = obj
        .get("label")
        .and_then(Value::as_str)
        .unwrap_or("Item")
        .to_string();
    let amount = json_to_decimal_string(obj.get("amount"))?;
    let kind = obj
        .get("kind")
        .and_then(Value::as_str)
        .map_or(CostItemKind::Other, CostItemKind::from_js_str);
    let quantity = obj
        .get("quantity")
        .and_then(Value::as_str)
        .map(str::to_string);
    let unit_price = obj
        .get("unitPrice")
        .and_then(Value::as_str)
        .map(str::to_string);

    with_draft(ctx, |d| {
        d.items.push(BillingLineItem {
            label,
            amount,
            kind,
            quantity,
            unit_price,
        });
    })?;
    Ok(JsValue::undefined())
}

/// Implements `b.draft.addInput / addOutput / addCacheRead / addCacheWrite / addOther`.
fn js_draft_add_typed(
    args: &[JsValue],
    ctx: &mut Context,
    kind: CostItemKind,
) -> JsResult<JsValue> {
    let label = args
        .get_or_undefined(0)
        .to_string(ctx)?
        .to_std_string_escaped();
    let amt_val = args.get_or_undefined(1).to_json(ctx)?;
    let amount = json_to_decimal_string(Some(&amt_val))?;
    let quantity = if args.get_or_undefined(2).is_null_or_undefined() {
        None
    } else {
        Some(
            args.get_or_undefined(2)
                .to_string(ctx)?
                .to_std_string_escaped(),
        )
    };
    let unit_price = if args.get_or_undefined(3).is_null_or_undefined() {
        None
    } else {
        Some(
            args.get_or_undefined(3)
                .to_string(ctx)?
                .to_std_string_escaped(),
        )
    };
    with_draft(ctx, |d| {
        d.items.push(BillingLineItem {
            label,
            amount,
            kind,
            quantity,
            unit_price,
        });
    })?;
    Ok(JsValue::undefined())
}

/// Implements `b.draft.setTotal(currency, amount, label?)`.
fn js_draft_set_total(args: &[JsValue], ctx: &mut Context) -> JsResult<JsValue> {
    let currency = args
        .get_or_undefined(0)
        .to_string(ctx)?
        .to_std_string_escaped();
    let amt_val = args.get_or_undefined(1).to_json(ctx)?;
    let amount = json_to_decimal_string(Some(&amt_val))?;
    let label = if args.get_or_undefined(2).is_null_or_undefined() {
        "总费用".to_string()
    } else {
        args.get_or_undefined(2)
            .to_string(ctx)?
            .to_std_string_escaped()
    };
    with_draft(ctx, |d| {
        d.items.clear();
        d.currency = Some(currency);
        d.items.push(BillingLineItem {
            label,
            amount,
            kind: CostItemKind::Other,
            quantity: None,
            unit_price: None,
        });
    })?;
    Ok(JsValue::undefined())
}

/// Implements `b.draft.overrideUsage(patch)`.
fn js_draft_override_usage(args: &[JsValue], ctx: &mut Context) -> JsResult<JsValue> {
    let json_val = args.get_or_undefined(0).to_json(ctx)?;
    let patch: UsageOverride = serde_json::from_value(json_val).map_err(|err| {
        JsNativeError::typ().with_message(format!("invalid usage override: {err}"))
    })?;
    with_draft(ctx, |d| {
        let target = d.usage_override.get_or_insert_with(UsageOverride::default);
        if patch.input_tokens.is_some() {
            target.input_tokens = patch.input_tokens;
        }
        if patch.output_tokens.is_some() {
            target.output_tokens = patch.output_tokens;
        }
        if patch.cache_read_tokens.is_some() {
            target.cache_read_tokens = patch.cache_read_tokens;
        }
        if patch.cache_creation_tokens.is_some() {
            target.cache_creation_tokens = patch.cache_creation_tokens;
        }
        if patch.reasoning_tokens.is_some() {
            target.reasoning_tokens = patch.reasoning_tokens;
        }
        if let Some(extra) = patch.extra_tokens {
            let map = target.extra_tokens.get_or_insert_with(BTreeMap::new);
            for (k, v) in extra {
                map.insert(k, v);
            }
        }
    })?;
    Ok(JsValue::undefined())
}

/// Converts a JSON string/number value into a validated decimal string.
fn json_to_decimal_string(val: Option<&Value>) -> JsResult<String> {
    let Some(v) = val else {
        return Err(JsNativeError::typ()
            .with_message("missing decimal amount")
            .into());
    };
    let s = match v {
        Value::String(s) => s.trim().to_string(),
        Value::Number(n) => n.to_string(),
        _ => {
            return Err(JsNativeError::typ()
                .with_message("decimal amount must be string or number")
                .into());
        }
    };
    let d = Decimal::from_str(&s).map_err(|err| {
        JsNativeError::typ().with_message(format!("invalid decimal '{s}': {err}"))
    })?;
    Ok(d.normalize().to_string())
}

/// Parses a non-negative `Decimal` from string.
fn parse_non_negative_decimal(s: &str) -> Result<Decimal> {
    let d = Decimal::from_str(s.trim())?;
    if d < Decimal::ZERO {
        bail!("negative monetary amount is not allowed: {s}");
    }
    Ok(d)
}

/// Parses a JS `JsValue` argument into a `Decimal`.
fn js_arg_to_decimal(val: &JsValue, ctx: &mut Context) -> JsResult<Decimal> {
    let s = val.to_string(ctx)?.to_std_string_escaped();
    Decimal::from_str(s.trim()).map_err(|err| {
        JsNativeError::typ()
            .with_message(format!("invalid decimal '{s}': {err}"))
            .into()
    })
}

/// Implements `linguist.costPerMillion(tokens, ratePerMillion)`.
fn js_cost_per_million(args: &[JsValue], ctx: &mut Context) -> JsResult<JsValue> {
    let tokens_f = args.get_or_undefined(0).to_number(ctx)?;
    if !tokens_f.is_finite() || tokens_f < 0.0 {
        return Ok(JsValue::new(js_string!("0")));
    }
    #[allow(clippy::cast_possible_truncation)]
    let tokens = Decimal::from(tokens_f as i64);
    let rate = js_arg_to_decimal(args.get_or_undefined(1), ctx)?;
    let million = Decimal::from(1_000_000_u64);
    let cost = tokens
        .checked_mul(rate)
        .and_then(|v| v.checked_div(million))
        .ok_or_else(|| JsNativeError::range().with_message("decimal overflow"))?;
    Ok(JsValue::new(js_string!(cost.normalize().to_string())))
}

/// Implements `linguist.decAdd(...values)`.
fn js_dec_add(args: &[JsValue], ctx: &mut Context) -> JsResult<JsValue> {
    let mut sum = Decimal::ZERO;
    for arg in args {
        let d = js_arg_to_decimal(arg, ctx)?;
        sum = sum
            .checked_add(d)
            .ok_or_else(|| JsNativeError::range().with_message("decimal addition overflow"))?;
    }
    Ok(JsValue::new(js_string!(sum.normalize().to_string())))
}

/// Implements `linguist.decSub(a, b)`.
fn js_dec_sub(args: &[JsValue], ctx: &mut Context) -> JsResult<JsValue> {
    let a = js_arg_to_decimal(args.get_or_undefined(0), ctx)?;
    let b = js_arg_to_decimal(args.get_or_undefined(1), ctx)?;
    let diff = a
        .checked_sub(b)
        .ok_or_else(|| JsNativeError::range().with_message("decimal subtraction overflow"))?;
    Ok(JsValue::new(js_string!(diff.normalize().to_string())))
}

/// Implements `linguist.decMul(a, b)`.
fn js_dec_mul(args: &[JsValue], ctx: &mut Context) -> JsResult<JsValue> {
    let a = js_arg_to_decimal(args.get_or_undefined(0), ctx)?;
    let b = js_arg_to_decimal(args.get_or_undefined(1), ctx)?;
    let prod = a
        .checked_mul(b)
        .ok_or_else(|| JsNativeError::range().with_message("decimal multiplication overflow"))?;
    Ok(JsValue::new(js_string!(prod.normalize().to_string())))
}

/// Standard tier pricing spec accepted by `linguist.tierBilling(ctx, spec)`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsStandardPricingSpec {
    /// Currency code.
    currency: String,
    /// Optional price source label.
    #[serde(default)]
    source: String,
    /// Optional inclusive maximum prompt tokens.
    #[serde(default)]
    max_input_tokens: Option<i64>,
    /// Ordered tiers.
    tiers: Vec<JsStandardTier>,
}

/// Single price tier in `JsStandardPricingSpec`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsStandardTier {
    /// Inclusive lower prompt boundary.
    min_input_tokens: i64,
    /// Uncached input price per 1M tokens.
    input_price: String,
    /// Output price per 1M tokens.
    output_price: String,
    /// Optional cache read price per 1M tokens.
    #[serde(default)]
    cache_read_price: Option<String>,
    /// Cache write billing mode.
    cache_write_mode: String,
    /// Optional cache write price per 1M tokens.
    #[serde(default)]
    cache_write_price: Option<String>,
}

/// Implements `linguist.tierBilling(bCtx, spec)` using exact `Decimal` tier math.
#[allow(clippy::too_many_lines)]
fn js_tier_billing(args: &[JsValue], ctx: &mut Context) -> JsResult<JsValue> {
    let b_json = args.get_or_undefined(0).to_json(ctx)?;
    let spec_json = args.get_or_undefined(1).to_json(ctx)?;
    let spec: JsStandardPricingSpec = serde_json::from_value(spec_json)
        .map_err(|err| JsNativeError::typ().with_message(format!("invalid pricing spec: {err}")))?;

    let raw_usage = b_json.get("rawUsage").filter(|v| !v.is_null());
    if raw_usage.is_none() {
        return Ok(JsValue::undefined());
    }

    let tokens = b_json.get("tokens").and_then(Value::as_object);
    let prompt = tokens
        .and_then(|t| t.get("input"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let output = tokens
        .and_then(|t| t.get("output"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let cache_read = tokens
        .and_then(|t| t.get("cacheRead"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let cache_write = tokens
        .and_then(|t| t.get("cacheCreation"))
        .and_then(Value::as_i64)
        .unwrap_or(0);

    if spec.max_input_tokens.is_some_and(|max| prompt > max) {
        with_draft(ctx, |d| d.status = Some("unpriced".to_string()))?;
        return Ok(JsValue::undefined());
    }

    let Some(tier) = spec
        .tiers
        .iter()
        .rev()
        .find(|t| t.min_input_tokens <= prompt)
    else {
        return Ok(JsValue::undefined());
    };

    let input_rate = Decimal::from_str(&tier.input_price)
        .map_err(|e| JsNativeError::typ().with_message(format!("invalid inputPrice: {e}")))?;
    let output_rate = Decimal::from_str(&tier.output_price)
        .map_err(|e| JsNativeError::typ().with_message(format!("invalid outputPrice: {e}")))?;
    let read_rate = match &tier.cache_read_price {
        Some(p) => Decimal::from_str(p).map_err(|e| {
            JsNativeError::typ().with_message(format!("invalid cacheReadPrice: {e}"))
        })?,
        None => input_rate,
    };
    let write_rate = match tier.cache_write_mode.as_str() {
        "separate" => {
            Decimal::from_str(tier.cache_write_price.as_deref().unwrap_or("0")).map_err(|e| {
                JsNativeError::typ().with_message(format!("invalid cacheWritePrice: {e}"))
            })?
        }
        _ => input_rate,
    };

    let uncached_in = (prompt - cache_read - cache_write).max(0);
    let million = Decimal::from(1_000_000_u64);
    let calc = |tok: i64, rate: Decimal| -> String {
        Decimal::from(tok)
            .checked_mul(rate)
            .and_then(|v| v.checked_div(million))
            .unwrap_or(Decimal::ZERO)
            .normalize()
            .to_string()
    };

    let source = spec.source;
    with_draft(ctx, |d| {
        d.currency = Some(spec.currency);
        d.items.push(BillingLineItem {
            label: "普通输入".to_string(),
            amount: calc(uncached_in, input_rate),
            kind: CostItemKind::Input,
            quantity: Some(format!("{uncached_in} tok")),
            unit_price: Some(tier.input_price.clone()),
        });
        d.items.push(BillingLineItem {
            label: "输出".to_string(),
            amount: calc(output, output_rate),
            kind: CostItemKind::Output,
            quantity: Some(format!("{output} tok")),
            unit_price: Some(tier.output_price.clone()),
        });
        if cache_read > 0 {
            d.items.push(BillingLineItem {
                label: "缓存读取".to_string(),
                amount: calc(cache_read, read_rate),
                kind: CostItemKind::CacheRead,
                quantity: Some(format!("{cache_read} tok")),
                unit_price: tier.cache_read_price.clone(),
            });
        }
        if cache_write > 0 {
            d.items.push(BillingLineItem {
                label: "缓存写入".to_string(),
                amount: calc(cache_write, write_rate),
                kind: CostItemKind::CacheWrite,
                quantity: Some(format!("{cache_write} tok")),
                unit_price: tier.cache_write_price.clone(),
            });
        }
        if !source.is_empty() {
            d.meta.insert("source".to_string(), Value::String(source));
        }
    })?;

    Ok(JsValue::undefined())
}

/// Parsed options for `linguist.http.fetchJson` / `fetchText`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsHttpOptions {
    /// HTTP method (`GET`, `POST`, `PUT`, `DELETE`).
    #[serde(default)]
    method: Option<String>,
    /// Optional request headers.
    #[serde(default)]
    headers: BTreeMap<String, String>,
    /// Optional request body (string or JSON object).
    #[serde(default)]
    body: Option<Value>,
    /// Optional per-call timeout in milliseconds.
    #[serde(default)]
    timeout_ms: Option<u64>,
    /// Optional Singleflight + TTL cache key.
    #[serde(default)]
    cache_key: Option<String>,
    /// Optional TTL duration in seconds.
    #[serde(default)]
    cache_ttl_secs: Option<u64>,
}

/// Implements `linguist.http.fetchJson` and `linguist.http.fetchText` returning a `Promise`.
fn js_http_fetch(args: &[JsValue], ctx: &mut Context, parse_json: bool) -> JsResult<JsValue> {
    let url = args
        .get_or_undefined(0)
        .to_string(ctx)?
        .to_std_string_escaped();
    let opts: JsHttpOptions = if args.get_or_undefined(1).is_null_or_undefined() {
        JsHttpOptions::default()
    } else {
        let json_val = args.get_or_undefined(1).to_json(ctx)?;
        serde_json::from_value(json_val).map_err(|err| {
            JsNativeError::typ().with_message(format!("invalid fetch options: {err}"))
        })?
    };

    let slot_id = active_slot_id(ctx)?;
    let (http, calls_used, max_calls, default_timeout_ms, allow_network) =
        HOST_SLOTS.with(|map| {
            let map_ref = map.borrow();
            let slot = map_ref
                .get(&slot_id)
                .ok_or_else(|| JsNativeError::typ().with_message("expired host slot"))?;
            Ok::<_, boa_engine::JsError>((
                slot.http.clone(),
                Rc::clone(&slot.http_calls_used),
                slot.max_http_calls,
                slot.default_net_timeout_ms,
                slot.allow_network,
            ))
        })?;

    if !allow_network {
        return Err(JsNativeError::typ()
            .with_message("linguist.http is disabled during compile-time evaluation")
            .into());
    }

    let used = calls_used.fetch_add(1, Ordering::Relaxed);
    if used >= max_calls {
        return Err(JsNativeError::range()
            .with_message(format!(
                "linguist.http call limit ({max_calls}) exceeded for this stage"
            ))
            .into());
    }

    let promise = JsPromise::from_future(
        async move {
            let result = execute_http_fetch(http, url, opts, default_timeout_ms).await;
            match result {
                Ok(raw_json) => Ok(if parse_json {
                    let parsed: Value = serde_json::from_str(&raw_json).map_err(|e| {
                        JsNativeError::typ().with_message(format!("invalid JSON payload: {e}"))
                    })?;
                    let body_str = parsed
                        .get("body")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let body_val: Value = serde_json::from_str(body_str).map_err(|e| {
                        JsNativeError::typ()
                            .with_message(format!("response is not valid JSON: {e}"))
                    })?;
                    // Convert via `serde_json::Value` inside a synchronous context step.
                    let encoded = serde_json::to_string(&body_val).unwrap_or_default();
                    JsValue::new(js_string!(encoded))
                } else {
                    JsValue::new(js_string!(raw_json))
                }),
                Err(err) => Err(JsNativeError::typ()
                    .with_message(format!("linguist.http error: {err}"))
                    .into()),
            }
        },
        ctx,
    );

    // Parse the JSON string inside `.then(JSON.parse)` on JS side so `JsValue::from_json` runs cleanly.
    let parse_code = if parse_json {
        "(p) => p.then((s) => JSON.parse(s))"
    } else {
        "(p) => p"
    };
    let helper_fn = boa_engine::Script::parse(Source::from_bytes(parse_code.as_bytes()), None, ctx)
        .map_err(|e| JsNativeError::typ().with_message(e.to_string()))?
        .evaluate(ctx)?;
    if let Some(callable) = helper_fn.as_callable() {
        return callable.call(&JsValue::undefined(), &[promise.into()], ctx);
    }
    Ok(promise.into())
}

/// Executes an SSRF-checked HTTP request with optional Singleflight + TTL memory caching.
async fn execute_http_fetch(
    http: HttpContext,
    url: String,
    opts: JsHttpOptions,
    default_timeout_ms: u64,
) -> Result<String> {
    if let Some(cache_key) = &opts.cache_key
        && let Some(cached) = http.cache.get(cache_key)
    {
        return Ok(cached);
    }

    if let Some(cache_key) = opts.cache_key.clone() {
        let mut inflight_rx: Option<watch::Receiver<Option<Result<String, String>>>> = None;
        let mut leader_tx: Option<watch::Sender<Option<Result<String, String>>>> = None;

        if let Ok(mut guard) = http.cache.inflight.lock() {
            if let Some(existing_rx) = guard.get(&cache_key) {
                inflight_rx = Some(existing_rx.clone());
            } else {
                let (tx, rx) = watch::channel(None);
                guard.insert(cache_key.clone(), rx);
                leader_tx = Some(tx);
            }
        }

        if let Some(mut rx) = inflight_rx {
            let wait_res = tokio::time::timeout(
                Duration::from_millis(opts.timeout_ms.unwrap_or(default_timeout_ms).max(100)),
                async {
                    loop {
                        if let Some(res) = rx.borrow().clone() {
                            return res;
                        }
                        if rx.changed().await.is_err() {
                            return Err("inflight request cancelled".to_string());
                        }
                    }
                },
            )
            .await;
            return match wait_res {
                Ok(Ok(val)) => Ok(val),
                Ok(Err(msg)) => bail!("{msg}"),
                Err(_) => bail!("timed out waiting for singleflight cache"),
            };
        }

        let res = perform_raw_http(&http, &url, &opts, default_timeout_ms).await;
        if let Ok(mut guard) = http.cache.inflight.lock() {
            guard.remove(&cache_key);
        }
        match res {
            Ok(payload) => {
                http.cache.insert(
                    cache_key,
                    payload.clone(),
                    opts.cache_ttl_secs.unwrap_or(60),
                );
                if let Some(tx) = leader_tx {
                    let _ = tx.send(Some(Ok(payload.clone())));
                }
                Ok(payload)
            }
            Err(err) => {
                let msg = err.to_string();
                if let Some(tx) = leader_tx {
                    let _ = tx.send(Some(Err(msg.clone())));
                }
                bail!("{msg}")
            }
        }
    } else {
        perform_raw_http(&http, &url, &opts, default_timeout_ms).await
    }
}

/// Validates target URL against SSRF rules and performs the bounded HTTP request.
async fn perform_raw_http(
    http: &HttpContext,
    url_str: &str,
    opts: &JsHttpOptions,
    default_timeout_ms: u64,
) -> Result<String> {
    let parsed = reqwest::Url::parse(url_str).context("invalid URL")?;
    if !matches!(parsed.scheme(), "http" | "https") {
        bail!("unsupported URL scheme '{}'", parsed.scheme());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| anyhow!("URL missing host"))?;
    let port = parsed.port_or_known_default().unwrap_or(443);

    let explicitly_allowed = http.config.allowed_hosts.iter().any(|allowed| {
        let a = allowed.trim().to_ascii_lowercase();
        !a.is_empty()
            && (host.eq_ignore_ascii_case(&a)
                || host.to_ascii_lowercase().ends_with(&format!(".{a}")))
    });

    if !http.config.allow_private_network && !explicitly_allowed {
        if let Ok(ip) = IpAddr::from_str(host) {
            if is_private_or_reserved_ip(ip) {
                bail!("blocked private/reserved IP address '{ip}' (set allowed_hosts to permit)");
            }
        } else {
            let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
                .await
                .with_context(|| format!("DNS lookup failed for '{host}'"))?
                .collect();
            if addrs.is_empty() {
                bail!("DNS returned no addresses for '{host}'");
            }
            for addr in addrs {
                if is_private_or_reserved_ip(addr.ip()) {
                    bail!(
                        "blocked private/reserved IP '{}' resolved from '{host}'",
                        addr.ip()
                    );
                }
            }
        }
    }

    let method_str = opts
        .method
        .as_deref()
        .unwrap_or("GET")
        .trim()
        .to_ascii_uppercase();
    let method = match method_str.as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "DELETE" => reqwest::Method::DELETE,
        other => bail!("unsupported HTTP method '{other}'"),
    };

    let timeout = Duration::from_millis(opts.timeout_ms.unwrap_or(default_timeout_ms).max(100));
    let mut req = http.client.request(method, parsed).timeout(timeout);
    for (k, v) in &opts.headers {
        req = req.header(k, v);
    }
    if let Some(body) = &opts.body {
        match body {
            Value::String(s) => req = req.body(s.clone()),
            other => req = req.json(other),
        }
    }

    let resp = req.send().await.context("HTTP request failed")?;
    let status = resp.status().as_u16();
    let bytes = resp.bytes().await.context("failed to read HTTP response")?;
    if bytes.len() > MAX_HTTP_BODY_BYTES {
        bail!("HTTP response exceeded 1 MiB limit ({} bytes)", bytes.len());
    }
    let body_text = String::from_utf8_lossy(&bytes).to_string();
    Ok(json!({ "status": status, "body": body_text }).to_string())
}

/// Checks whether an IP address is loopback, private, link-local, CGNAT, or multicast.
fn is_private_or_reserved_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || (o[0] == 100 && (o[1] & 0b1100_0000) == 0b0100_0000)
        }
        IpAddr::V6(v6) => {
            let seg = v6.segments();
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (seg[0] & 0xfe00) == 0xfc00
                || (seg[0] & 0xffc0) == 0xfe80
                || v6
                    .to_ipv4_mapped()
                    .is_some_and(|v4| is_private_or_reserved_ip(IpAddr::V4(v4)))
        }
    }
}

/// Converts JS whole-number `f64` values back to JSON integers.
fn normalize_whole_json_numbers(val: &mut Value) {
    match val {
        Value::Number(num) => {
            if !num.is_i64()
                && !num.is_u64()
                && let Some(f) = num.as_f64()
                && f.is_finite()
                && f.fract() == 0.0
                && (-9_007_199_254_740_991.0..=9_007_199_254_740_991.0).contains(&f)
            {
                #[allow(clippy::cast_possible_truncation)]
                let int_val = f as i64;
                *num = serde_json::Number::from(int_val);
            }
        }
        Value::Array(items) => {
            for item in items {
                normalize_whole_json_numbers(item);
            }
        }
        Value::Object(map) => {
            for item in map.values_mut() {
                normalize_whole_json_numbers(item);
            }
        }
        _ => {}
    }
}

/// Restores read-only fields on `mutated` from `original` so scripts cannot forge
/// immutable stage/entity/request metadata.
fn enforce_readonly_fields(original: &ScriptContext, mutated: &mut ScriptContext) {
    mutated.stage = original.stage;
    mutated.project.clone_from(&original.project);
    mutated.call_model.clone_from(&original.call_model);
    mutated.route_info.clone_from(&original.route_info);
    mutated.provider.clone_from(&original.provider);
    mutated.model.clone_from(&original.model);
    mutated.route.rule_id.clone_from(&original.route.rule_id);
    mutated.request.uid.clone_from(&original.request.uid);
    mutated.request.attempt = original.request.attempt;
    mutated
        .request
        .signals
        .clone_from(&original.request.signals);
}
