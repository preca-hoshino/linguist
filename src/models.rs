//! Domain models, PostgreSQL catalog structs, `ScriptContext` contracts, and telemetry DTOs.

use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;

use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use uuid::Uuid;

/// Single script unit inside an entity's ordered script chain (`scripts[]`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScriptItem {
    /// Unique identifier within the entity's script list.
    pub id: String,
    /// Human-readable display label.
    pub name: String,
    /// Whether this script participates in compilation and execution.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// TypeScript or JavaScript source code.
    #[serde(default)]
    pub code: String,
}

/// Helper default returning `true` for serde defaults.
const fn default_true() -> bool {
    true
}

/// Pre-compiled executable representation of a single enabled `ScriptItem`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompiledScriptUnit {
    /// Process-unique monotonic identifier for VM module caching.
    pub compile_id: u64,
    /// Script identifier.
    pub id: String,
    /// Script display name.
    pub name: String,
    /// Transpiled JavaScript source ready for module execution.
    pub js_code: String,
    /// Whether this script exports `onRequest` (or uses legacy inline statement form).
    pub has_on_request: bool,
    /// Whether this script exports `onBilling`.
    pub has_on_billing: bool,
}

/// Aggregated compile-time metadata extracted from an entity's ordered `scripts[]`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CompiledScriptChain {
    /// Deduplicated union of `export const tags` across enabled scripts.
    pub tags: Vec<String>,
    /// Shallow-merged `export const meta` across enabled scripts (later overwrites earlier).
    pub meta: Map<String, Value>,
    /// Distinct hook names exported (`"onRequest"`, `"onBilling"`).
    pub hooks: Vec<String>,
    /// Ordered compiled units for enabled scripts that export at least one runtime hook.
    pub units: Vec<CompiledScriptUnit>,
}

/// Normalized supply-side provider configuration loaded into `RuntimeCatalog`.
#[derive(Debug, Clone)]
pub struct ProviderConfig {
    /// Stable provider identifier.
    pub id: String,
    /// Human-readable display name.
    pub name: String,
    /// Gateway-managed `LobeHub` icon slug.
    pub icon: String,
    /// Whether this provider is enabled.
    pub enabled: bool,
    /// Upstream bearer API key (exposed only in stages ④⑤ and `onBilling`, scrubbed from logs).
    pub api_key: String,
    /// Ordered script chain.
    pub scripts: Vec<ScriptItem>,
    /// Pre-compiled declarations and hooks extracted from `scripts`.
    pub compiled: CompiledScriptChain,
    /// Configured models under this provider.
    pub models: Vec<ModelConfig>,
}

/// Normalized supply-side model configuration loaded into `RuntimeCatalog`.
#[derive(Debug, Clone)]
pub struct ModelConfig {
    /// Upstream model identifier.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Gateway-managed `LobeHub` icon slug.
    pub icon: String,
    /// Whether this model is enabled.
    pub enabled: bool,
    /// Ordered script chain.
    pub scripts: Vec<ScriptItem>,
    /// Pre-compiled declarations and hooks extracted from `scripts`.
    pub compiled: CompiledScriptChain,
}

/// Normalized consume-side project configuration.
#[derive(Debug, Clone)]
pub struct ProjectConfig {
    /// Project identifier.
    pub id: String,
    /// Project display name.
    pub name: String,
    /// Gateway-managed `LobeHub` icon slug.
    pub icon: String,
    /// Whether this project is enabled.
    pub enabled: bool,
    /// Plaintext gateway authentication key (stripped before entering `ScriptContext`).
    pub api_key: String,
    /// Ordered script chain.
    pub scripts: Vec<ScriptItem>,
    /// Pre-compiled declarations and hooks extracted from `scripts`.
    pub compiled: CompiledScriptChain,
    /// Configured call models.
    pub call_models: Vec<CallModelConfig>,
}

/// Normalized consume-side call-model configuration.
#[derive(Debug, Clone)]
pub struct CallModelConfig {
    /// Call model identifier clients send as `model`.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Gateway-managed `LobeHub` icon slug.
    pub icon: String,
    /// Whether this call model is enabled.
    pub enabled: bool,
    /// Ordered script chain.
    pub scripts: Vec<ScriptItem>,
    /// Pre-compiled declarations and hooks extracted from `scripts`.
    pub compiled: CompiledScriptChain,
}

/// Normalized routing rule stored in `RuntimeCatalog` (evaluated in `position` order).
#[derive(Debug, Clone)]
pub struct RouteRuleConfig {
    /// Unique rule identifier (`ctx.route.ruleId`).
    pub id: String,
    /// Rule display name.
    pub name: String,
    /// Gateway-managed `LobeHub` icon slug.
    pub icon: String,
    /// Enabled flag.
    pub enabled: bool,
    /// Ascending evaluation order.
    pub position: i64,
    /// Ordered script chain.
    pub scripts: Vec<ScriptItem>,
    /// Pre-compiled declarations and hooks extracted from `scripts`.
    pub compiled: CompiledScriptChain,
}

/// Five unidirectional script execution stages matching `linguist.d.ts`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ScriptStage {
    /// ① Project-level outbound script chain.
    Project,
    /// ② Call-model-level outbound script chain.
    CallModel,
    /// ③ Route selection outbound script chain.
    Route,
    /// ④ Supply model outbound script chain.
    Model,
    /// ⑤ Supply provider outbound script chain.
    Provider,
}

impl fmt::Display for ScriptStage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let label = match self {
            Self::Project => "project",
            Self::CallModel => "callModel",
            Self::Route => "route",
            Self::Model => "model",
            Self::Provider => "provider",
        };
        f.write_str(label)
    }
}

/// Unified entity descriptor exposed to scripts across all 5 dimensions (`EntityInfo`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EntityInfo {
    /// Entity ID.
    pub id: String,
    /// Entity display name.
    pub name: String,
    /// Gateway-managed `LobeHub` icon slug.
    pub icon: String,
    /// Merged `export const tags` declared by the entity's scripts.
    pub tags: Vec<String>,
    /// Merged `export const meta` declared by the entity's scripts.
    pub meta: Map<String, Value>,
}

/// Supply-side provider descriptor exposed in stages ④, ⑤, and `onBilling` (`ProviderInfo`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    /// Provider ID.
    pub id: String,
    /// Provider display name.
    pub name: String,
    /// Gateway-managed `LobeHub` icon slug.
    pub icon: String,
    /// Merged `export const tags` declared by the provider's scripts.
    pub tags: Vec<String>,
    /// Merged `export const meta` declared by the provider's scripts.
    pub meta: Map<String, Value>,
    /// Upstream API key (populated only in stages ④, ⑤, and `onBilling`; scrubbed before logging).
    pub api_key: String,
}

/// Route state exposed as `ctx.route`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteState {
    /// Matched rule ID once a route selects a target (`null` prior to selection).
    pub rule_id: Option<String>,
    /// Candidate pool (filterable in stages ①/②/③).
    pub candidates: Vec<CandidateItem>,
    /// Selected primary target.
    pub target: Option<RouteEndpoint>,
    /// Ordered fallback targets.
    pub fallbacks: Vec<RouteEndpoint>,
    /// Whether subsequent routes may continue executing even after `target` is set.
    #[serde(rename = "continue", default)]
    pub continue_routing: bool,
    /// Whether response `model` should be rewritten to `callModel.id`.
    pub rewrite_response_model: bool,
}

/// Target endpoint pair (`providerId`, `modelId`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RouteEndpoint {
    /// Target provider ID.
    pub provider_id: String,
    /// Target model ID.
    pub model_id: String,
    /// Maximum attempts for this endpoint, including the initial request (1 through 5).
    #[serde(
        default = "default_max_attempts",
        deserialize_with = "deserialize_max_attempts"
    )]
    pub max_attempts: u8,
}

/// Default to a single attempt for existing route endpoints.
const fn default_max_attempts() -> u8 {
    1
}

/// Reject invalid retry counts in script-generated endpoints.
fn deserialize_max_attempts<'de, D>(deserializer: D) -> Result<u8, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let attempts = u8::deserialize(deserializer)?;
    if (1..=5).contains(&attempts) {
        Ok(attempts)
    } else {
        Err(serde::de::Error::custom(
            "maxAttempts must be between 1 and 5",
        ))
    }
}

/// Candidate entry inside `ctx.route.candidates`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateItem {
    /// Supply-side provider descriptor.
    pub provider: EntityInfo,
    /// Supply-side model descriptor.
    pub model: EntityInfo,
    /// Live sliding-window telemetry metrics.
    pub metrics: CandidateMetrics,
}

/// Real-time sliding-window speed & health metrics for routing decisions.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CandidateMetrics {
    /// Average decode tokens per second.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avg_decode_tps: Option<f64>,
    /// Median decode tokens per second.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub p50_decode_tps: Option<f64>,
    /// Average time-to-first-token in milliseconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avg_ttft_ms: Option<f64>,
    /// Ratio of failed attempts in the active sliding window (`0.0..=1.0`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_rate: Option<f64>,
}

/// Outbound HTTP request state exposed as `ctx.request`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestState {
    /// Unique request/attempt UUID string (read-only).
    pub uid: String,
    /// 1-based attempt number (read-only).
    pub attempt: u16,
    /// Outbound HTTP URL (pre-populated before stage ④).
    pub url: String,
    /// Mutable outbound request headers.
    pub headers: BTreeMap<String, String>,
    /// Mutable `OpenAI` chat completions JSON body.
    pub body: Map<String, Value>,
    /// Whether the gateway injects `stream_options.include_usage = true` for streaming calls.
    #[serde(default = "default_true")]
    pub inject_stream_options: bool,
    /// Optional per-request upstream timeout override in seconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_secs: Option<u64>,
    /// Optional per-request list of HTTP status codes triggering fallback.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_status_codes: Option<Vec<u16>>,
    /// Read-only derived signals extracted from the incoming payload.
    pub signals: RequestSignals,
}

/// Pre-computed request signals exposed as `ctx.request.signals`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RequestSignals {
    /// Whether `stream === true`.
    pub is_stream: bool,
    /// Whether any message part includes image content.
    pub has_vision_images: bool,
    /// Whether `tools` array is non-empty.
    pub has_tools: bool,
    /// Number of messages in `body.messages`.
    pub message_count: usize,
    /// Estimated total character length across `messages`.
    pub estimated_input_chars: usize,
}

/// Script rejection directive triggering an immediate HTTP error response.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RejectDirective {
    /// HTTP status code returned to caller.
    pub status_code: u16,
    /// Error message returned in JSON error payload.
    pub message: String,
}

/// Unified context passed to and mutated by scripts across stages ①..⑤.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptContext {
    /// 1. Current execution stage (read-only).
    pub stage: ScriptStage,
    /// 2. Consume-side project descriptor (read-only).
    pub project: EntityInfo,
    /// 3. Consume-side call model descriptor (read-only).
    pub call_model: EntityInfo,
    /// 4. Active route rule descriptor in stage ③ (read-only).
    pub route_info: Option<EntityInfo>,
    /// 5. Supply-side provider descriptor (read-only, populated for stages ④ and ⑤).
    pub provider: Option<ProviderInfo>,
    /// 6. Supply-side model descriptor (read-only, populated for stages ④ and ⑤).
    pub model: Option<EntityInfo>,
    /// 7. Route control state.
    pub route: RouteState,
    /// 8. Mutable outbound HTTP request state.
    pub request: RequestState,
    /// 9. Cross-stage shared key-value bag.
    pub state: Map<String, Value>,
    /// 10. Immediate request rejection directive.
    pub reject: Option<RejectDirective>,
}

/// Completed request log record sent asynchronously to PostgreSQL.
#[derive(Debug, Clone)]
pub struct RequestLogRecord {
    /// Unique UID for this attempt.
    pub request_uid: Uuid,
    /// Root request UID shared across primary + fallback attempts.
    pub parent_request_uid: Option<Uuid>,
    /// 1-based attempt index.
    pub attempt_index: i16,
    /// Timestamp when the upstream attempt started.
    pub started_at: DateTime<Utc>,
    /// Timestamp when the request finished.
    pub created_at: DateTime<Utc>,
    /// Whether the SSE stream terminated early due to client disconnect or upstream interruption.
    pub interrupted: bool,
    /// Full raw upstream `usage` object preserved for `onBilling` scripts.
    pub raw_usage: Option<Value>,
    /// Snapshot of the catalog active when the request entered the gateway.
    pub catalog_snapshot: Option<Arc<crate::catalog::RuntimeCatalog>>,
    /// Project ID snapshot.
    pub project_id: String,
    /// Project display name snapshot.
    pub project_name: String,
    /// Call model ID snapshot.
    pub call_model_id: String,
    /// Call model display name snapshot.
    pub call_model_name: String,
    /// Provider ID snapshot.
    pub provider_id: String,
    /// Provider display name snapshot.
    pub provider_name: String,
    /// Upstream model ID snapshot.
    pub model_id: String,
    /// Upstream model display name snapshot.
    pub model_name: String,
    /// Matched route rule ID.
    pub route_rule_id: String,
    /// Whether request was SSE streaming.
    pub is_stream: bool,
    /// HTTP status code from upstream or gateway rejection.
    pub status_code: i32,
    /// Prompt tokens consumed.
    pub input_tokens: i64,
    /// Completion tokens generated.
    pub output_tokens: i64,
    /// Prompt cache read tokens.
    pub cache_read_tokens: i64,
    /// Prompt cache creation tokens.
    pub cache_creation_tokens: i64,
    /// Reasoning/thinking tokens.
    pub reasoning_tokens: i64,
    /// Total tokens (`input + output` or upstream `total_tokens`).
    pub total_tokens: i64,
    /// Extra non-standard token breakdown counters (`JSONB`).
    pub extra_tokens: BTreeMap<String, i64>,
    /// Time to first token in milliseconds.
    pub ttft_ms: f64,
    /// Total elapsed duration in milliseconds.
    pub total_duration_ms: f64,
    /// Net decode generation duration in milliseconds (`total - ttft`).
    pub generation_duration_ms: f64,
    /// Net decode tokens per second.
    pub decode_tps: f64,
    /// End-to-end tokens per second.
    pub e2e_tps: f64,
    /// Gateway internal pre-send overhead in milliseconds (`routing_ms + attempt_prep_ms`).
    pub gateway_overhead_ms: f64,
    /// Stages ①..③ routing & request intake duration in milliseconds.
    pub routing_ms: f64,
    /// Stages ④..⑤ attempt context & payload preparation duration in milliseconds.
    pub attempt_prep_ms: f64,
    /// Upstream HTTP response header latency in milliseconds.
    pub upstream_header_ms: f64,
    /// Upstream finish reason (`stop`, `length`, `tool_calls`, etc.).
    pub finish_reason: Option<String>,
    /// Effective `reasoning_effort` value sent to upstream.
    pub reasoning_effort: Option<String>,
    /// Token accounting source (`upstream_usage` or `fallback_estimated`).
    pub token_source: String,
    /// Cross-stage script state snapshot.
    pub script_state: Value,
    /// Optional error text for `request_payloads`.
    pub error_message: Option<String>,
    /// Optional sanitized request headers JSON.
    pub request_headers: Option<Value>,
    /// Optional request body JSON.
    pub request_body: Option<Value>,
    /// Optional response body JSON.
    pub response_body: Option<Value>,
}

/// Filter metadata returned by `/api/v1/stats/overview`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterEntityItem {
    /// Entity ID.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Resolved icon slug.
    pub icon: String,
}

/// Summary KPI strip returned by `/api/v1/stats/overview`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewSummary {
    /// Total tokens across the active range.
    pub total_tokens: i64,
    /// Total input tokens.
    pub input_tokens: i64,
    /// Total output tokens.
    pub output_tokens: i64,
    /// Total cache-read tokens.
    pub cache_read_tokens: i64,
    /// Cache hit percentage (`0.0..=100.0`).
    pub cache_hit_rate: f64,
    /// Total request count.
    pub total_requests: i64,
    /// Current consecutive active days streak.
    pub active_streak_days: i64,
    /// Most-used model summary if available.
    pub top_model: Option<TopModelSummary>,
}

/// Most-used model badge inside `OverviewSummary`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopModelSummary {
    /// Model ID.
    pub model_id: String,
    /// Model display name.
    pub model_name: String,
    /// Model icon slug.
    pub model_icon: String,
    /// Total tokens consumed by this model.
    pub total_tokens: i64,
}

/// Daily cell inside the 53-week contribution wall.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContributionDayCell {
    /// Calendar date (`YYYY-MM-DD`).
    pub date: NaiveDate,
    /// Total tokens on that day.
    pub total_tokens: i64,
    /// Input tokens on that day.
    pub input_tokens: i64,
    /// Output tokens on that day.
    pub output_tokens: i64,
    /// Cache-read tokens on that day.
    pub cache_read_tokens: i64,
    /// Total requests on that day.
    pub request_count: i64,
}

/// Full response DTO for `GET /api/v1/stats/overview`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewResponse {
    /// UI page title from config.
    pub title: String,
    /// Configured display timezone.
    pub timezone: String,
    /// Known projects for header dropdown filtering.
    pub projects: Vec<FilterEntityItem>,
    /// Known providers for header dropdown filtering.
    pub providers: Vec<FilterEntityItem>,
    /// Aggregated KPI metrics.
    pub summary: OverviewSummary,
    /// Daily contribution wall records.
    pub days: Vec<ContributionDayCell>,
}

/// Ranked model speed entry for `GET /api/v1/stats/leaderboard`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaderboardItem {
    /// Upstream model ID.
    pub model_id: String,
    /// Upstream model display name.
    pub model_name: String,
    /// Model icon slug.
    pub model_icon: String,
    /// Provider ID.
    pub provider_id: String,
    /// Provider display name.
    pub provider_name: String,
    /// Provider icon slug.
    pub provider_icon: String,
    /// Average decode tokens/s.
    pub avg_decode_tps: f64,
    /// Median (P50) decode tokens/s.
    pub p50_decode_tps: f64,
    /// 90th-percentile decode tokens/s.
    pub p90_decode_tps: f64,
    /// Average end-to-end tokens/s.
    pub avg_e2e_tps: f64,
    /// Average TTFT in milliseconds.
    pub avg_ttft_ms: f64,
    /// Sample count.
    pub request_count: i64,
    /// Total tokens processed.
    pub total_tokens: i64,
}

/// Single model series slice for a given day in `GET /api/v1/stats/daily-models`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyModelSlice {
    /// Upstream model ID.
    pub model_id: String,
    /// Model display name.
    pub model_name: String,
    /// Provider ID.
    pub provider_id: String,
    /// Total tokens for this model on this day.
    pub total_tokens: i64,
    /// Input tokens.
    pub input_tokens: i64,
    /// Output tokens.
    pub output_tokens: i64,
    /// Cache-read tokens.
    pub cache_read_tokens: i64,
}

/// Daily bucket returned by `GET /api/v1/stats/daily-models`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyModelDay {
    /// Calendar date (`YYYY-MM-DD`).
    pub date: NaiveDate,
    /// Per-model token slices for this date.
    pub models: Vec<DailyModelSlice>,
}

/// Recent request row returned by `GET /api/v1/stats/recent-requests`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentRequestItem {
    /// Unique request UID.
    pub request_uid: Uuid,
    /// Timestamp when logged.
    pub created_at: DateTime<Utc>,
    /// Project ID.
    pub project_id: String,
    /// Project display name.
    pub project_name: String,
    /// Consume-side call model ID.
    pub call_model_id: String,
    /// Consume-side call model display name.
    pub call_model_name: String,
    /// Provider ID.
    pub provider_id: String,
    /// Provider display name.
    pub provider_name: String,
    /// Provider `LobeHub` icon slug.
    pub provider_icon: String,
    /// Upstream model ID.
    pub model_id: String,
    /// Upstream model display name.
    pub model_name: String,
    /// Model `LobeHub` icon slug.
    pub model_icon: String,
    /// Matched route rule ID.
    pub route_rule_id: String,
    /// Attempt index (1 = primary, >1 = fallback).
    pub attempt_index: i16,
    /// HTTP status code.
    pub status_code: i32,
    /// Streaming request flag.
    pub is_stream: bool,
    /// Input tokens.
    pub input_tokens: i64,
    /// Output tokens.
    pub output_tokens: i64,
    /// Cache read tokens.
    pub cache_read_tokens: i64,
    /// Cache creation tokens.
    pub cache_creation_tokens: i64,
    /// Reasoning tokens.
    pub reasoning_tokens: i64,
    /// Total tokens.
    pub total_tokens: i64,
    /// Extra non-standard token counters.
    pub extra_tokens: BTreeMap<String, i64>,
    /// TTFT in milliseconds.
    pub ttft_ms: f64,
    /// Total duration in milliseconds.
    pub total_duration_ms: f64,
    /// Net decode tokens per second.
    pub decode_tps: f64,
    /// End-to-end tokens per second.
    pub e2e_tps: f64,
    /// Recorded billing currency code, if available.
    pub billing_currency: Option<String>,
    /// Recorded billing amount string in `billing_currency`.
    pub billing_amount: Option<String>,
    /// Reference-converted billing amount string in `display_currency`.
    pub billing_converted_amount: Option<String>,
    /// Recorded billing status (`priced`, `unpriced`, `script_error`, `estimated`, etc.).
    pub billing_status: Option<String>,
}

/// Paginated response returned by `GET /api/v1/stats/recent-requests`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentRequestsResponse {
    /// Request log rows on the current page.
    pub items: Vec<RecentRequestItem>,
    /// Current one-based page number.
    pub page: u32,
    /// Active page size.
    pub page_size: u32,
    /// Total matching rows across all pages.
    pub total: i64,
    /// Total page count (at least `1`).
    pub total_pages: u32,
    /// Whether another page follows `page`.
    pub has_next: bool,
    /// Configured display currency for reference conversion.
    pub display_currency: Option<String>,
    /// Available project filter options from the active catalog.
    pub projects: Vec<FilterEntityItem>,
    /// Available provider filter options from the active catalog.
    pub providers: Vec<FilterEntityItem>,
    /// Available model filter options from the active catalog.
    pub models: Vec<FilterEntityItem>,
}

/// Shared metadata and filter options returned by monitoring endpoints.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitoringMeta {
    /// Active time range key (`1h`, `6h`, `24h`, `7d`, `30d`, `90d`).
    pub range: String,
    /// Resolved time bucket granularity (`minute`, `hour`, `day`).
    pub granularity: String,
    /// Configured display timezone.
    pub timezone: String,
    /// Available project filters.
    pub projects: Vec<FilterEntityItem>,
    /// Available provider filters.
    pub providers: Vec<FilterEntityItem>,
    /// Available model filters (`provider_id/model_id` or `model_id`).
    pub models: Vec<FilterEntityItem>,
}

/// One time-bucketed point for the `traffic` monitoring dimension.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficBucket {
    /// Formatted bucket timestamp label.
    pub label: String,
    /// Total requests in this bucket.
    pub total_requests: i64,
    /// Successful requests (`200..400`).
    pub success_requests: i64,
    /// Failed requests (`>= 400`).
    pub error_requests: i64,
    /// Requests per minute during this bucket.
    pub rpm: f64,
    /// Error percentage (`0.0..=100.0`).
    pub error_rate: f64,
    /// Input tokens consumed.
    pub input_tokens: i64,
    /// Output tokens generated.
    pub output_tokens: i64,
    /// Cache read tokens.
    pub cache_read_tokens: i64,
    /// Cache creation tokens.
    pub cache_creation_tokens: i64,
    /// Reasoning tokens.
    pub reasoning_tokens: i64,
    /// Sum of extra token counters.
    pub extra_tokens_total: i64,
    /// Cache hit rate percentage (`0.0..=100.0`).
    pub cache_hit_rate: f64,
    /// Average input tokens per request.
    pub avg_input_tokens: f64,
    /// P90 input tokens per request.
    pub p90_input_tokens: f64,
    /// Average output tokens per request.
    pub avg_output_tokens: f64,
    /// P90 output tokens per request.
    pub p90_output_tokens: f64,
    /// Input tokens per minute.
    pub tpm_in: f64,
    /// Output tokens per minute.
    pub tpm_out: f64,
    /// Total tokens per minute.
    pub tpm_total: f64,
    /// RPM for requests with `0..32K` input tokens.
    pub rpm_0_32k: f64,
    /// RPM for requests with `32K..128K` input tokens.
    pub rpm_32k_128k: f64,
    /// RPM for requests with `>= 128K` input tokens.
    pub rpm_128k_plus: f64,
    /// TPM for requests with `0..32K` input tokens.
    pub tpm_0_32k: f64,
    /// TPM for requests with `32K..128K` input tokens.
    pub tpm_32k_128k: f64,
    /// TPM for requests with `>= 128K` input tokens.
    pub tpm_128k_plus: f64,
}

/// Summary totals for the `traffic` (用量) tab KPI strip.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficSummaryTotals {
    /// Total requests across the active window.
    pub total_requests: i64,
    /// Average RPM across the active window.
    pub avg_rpm: f64,
    /// Total tokens consumed.
    pub total_tokens: i64,
    /// Total input tokens.
    pub input_tokens: i64,
    /// Total output tokens.
    pub output_tokens: i64,
    /// Total cache read tokens.
    pub cache_read_tokens: i64,
    /// Total cache creation tokens.
    pub cache_creation_tokens: i64,
    /// Total reasoning tokens.
    pub reasoning_tokens: i64,
    /// Total extra tokens.
    pub extra_tokens: i64,
    /// Overall cache hit rate percentage.
    pub cache_hit_rate: f64,
}

/// Aggregated usage slice for donut / bar distribution charts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSlice {
    /// Entity identifier.
    pub id: String,
    /// Human-readable display name.
    pub name: String,
    /// Total tokens consumed.
    pub total_tokens: i64,
    /// Total request count.
    pub request_count: i64,
}

/// Response payload for `GET /api/v1/stats/monitoring/traffic`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficMonitoringResponse {
    /// Shared metadata and filters.
    pub meta: MonitoringMeta,
    /// Window summary KPI totals.
    pub totals: TrafficSummaryTotals,
    /// Time-series traffic and token buckets.
    pub buckets: Vec<TrafficBucket>,
    /// Top models + "其他" distribution.
    pub distribution_by_model: Vec<UsageSlice>,
    /// Top projects + "其他" distribution.
    pub distribution_by_project: Vec<UsageSlice>,
    /// Top providers + "其他" distribution.
    pub distribution_by_provider: Vec<UsageSlice>,
    /// Top call models + "其他" distribution.
    pub distribution_by_call_model: Vec<UsageSlice>,
}

/// One time-bucketed point for the `performance` monitoring dimension.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceBucket {
    /// Formatted bucket timestamp label.
    pub label: String,
    /// Median TTFT in milliseconds.
    pub ttft_p50: f64,
    /// P90 TTFT in milliseconds.
    pub ttft_p90: f64,
    /// P99 TTFT in milliseconds.
    pub ttft_p99: f64,
    /// Mean decode throughput (tokens/sec).
    pub decode_tps_avg: f64,
    /// Median decode throughput (tokens/sec).
    pub decode_tps_p50: f64,
    /// P90 decode throughput (tokens/sec).
    pub decode_tps_p90: f64,
    /// Mean TTFT in milliseconds.
    pub avg_ttft_ms: f64,
    /// Mean generation duration in milliseconds.
    pub avg_generation_ms: f64,
    /// Mean total request duration in milliseconds.
    pub avg_total_duration_ms: f64,
    /// Median total request duration in milliseconds.
    pub duration_p50: f64,
    /// P90 total request duration in milliseconds.
    pub duration_p90: f64,
    /// P99 total request duration in milliseconds.
    pub duration_p99: f64,
    /// Mean end-to-end throughput (tokens/sec).
    pub avg_e2e_tps: f64,
    /// Mean inter-token latency (TPOT, ms/token).
    pub tpot_avg: f64,
    /// Median TPOT (ms/token).
    pub tpot_p50: f64,
    /// P90 TPOT (ms/token).
    pub tpot_p90: f64,
    /// P99 TPOT (ms/token).
    pub tpot_p99: f64,
    /// Mean gateway internal pre-send overhead in milliseconds.
    pub avg_gateway_overhead_ms: f64,
    /// P50 gateway internal overhead in milliseconds.
    pub p50_gateway_overhead_ms: f64,
    /// P90 gateway internal overhead in milliseconds.
    pub p90_gateway_overhead_ms: f64,
    /// P99 gateway internal overhead in milliseconds.
    pub p99_gateway_overhead_ms: f64,
    /// Mean routing stage duration in milliseconds.
    pub avg_routing_ms: f64,
    /// Mean attempt preparation duration in milliseconds.
    pub avg_attempt_prep_ms: f64,
    /// Mean upstream HTTP response header latency in milliseconds.
    pub avg_upstream_header_ms: f64,
}

/// Summary KPIs for the `performance` tab.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceSummary {
    /// Mean gateway overhead in milliseconds.
    pub avg_gateway_overhead_ms: f64,
    /// Median TTFT in milliseconds.
    pub ttft_p50: f64,
    /// P90 TTFT in milliseconds.
    pub ttft_p90: f64,
    /// Median TPOT in ms/token.
    pub tpot_p50: f64,
    /// Mean decode TPS.
    pub decode_tps_avg: f64,
    /// Median decode TPS.
    pub decode_tps_p50: f64,
    /// Median total duration in milliseconds.
    pub duration_p50: f64,
    /// P90 total duration in milliseconds.
    pub duration_p90: f64,
}

/// Per-provider latency & speed benchmark item.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPerfItem {
    /// Provider ID.
    pub provider_id: String,
    /// Provider display name.
    pub provider_name: String,
    /// Mean TTFT in milliseconds.
    pub avg_ttft_ms: f64,
    /// Mean decode TPS.
    pub avg_decode_tps: f64,
    /// Mean TPOT in ms/token.
    pub avg_tpot_ms: f64,
    /// Request count.
    pub request_count: i64,
}

/// Stream vs non-stream performance comparison item.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamComparisonItem {
    /// `"stream"` or `"non_stream"`.
    pub mode: String,
    /// Request count.
    pub request_count: i64,
    /// Mean TTFT in milliseconds.
    pub avg_ttft_ms: f64,
    /// Mean total duration in milliseconds.
    pub avg_total_duration_ms: f64,
    /// Mean decode TPS.
    pub avg_decode_tps: f64,
}

/// Scatter point comparing latency vs throughput for one provider/model pair.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPerformancePoint {
    /// Provider identifier.
    pub provider_id: String,
    /// Provider display name.
    pub provider_name: String,
    /// Model identifier.
    pub model_id: String,
    /// Model display name.
    pub model_name: String,
    /// Mean TTFT in milliseconds.
    pub avg_ttft_ms: f64,
    /// Mean decode TPS.
    pub avg_decode_tps: f64,
    /// Number of requests in window.
    pub request_count: i64,
    /// Total tokens in window.
    pub total_tokens: i64,
}

/// Response payload for `GET /api/v1/stats/monitoring/performance`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceMonitoringResponse {
    /// Shared metadata and filters.
    pub meta: MonitoringMeta,
    /// Window performance summary KPIs.
    pub summary: PerformanceSummary,
    /// Time-series latency and throughput buckets.
    pub buckets: Vec<PerformanceBucket>,
    /// Top-10 provider/model performance scatter points.
    pub model_quadrant: Vec<ModelPerformancePoint>,
    /// TTFT latency distribution histogram buckets.
    pub ttft_histogram: Vec<NamedCount>,
    /// Per-provider latency & speed benchmarks.
    pub provider_benchmarks: Vec<ProviderPerfItem>,
    /// Stream vs non-stream performance comparison.
    pub stream_comparison: Vec<StreamComparisonItem>,
}

/// One time-bucketed point for the `routing` monitoring dimension.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingBucket {
    /// Formatted bucket timestamp label.
    pub label: String,
    /// Request counts keyed by rule ID (Top 5 + `"其他"`).
    pub rule_counts: BTreeMap<String, i64>,
    /// Requests succeeding on the first attempt (`attempt_index = 1` and `2xx`).
    pub first_try_success: i64,
    /// Requests succeeding after retry/fallback (`attempt_index > 1` and `2xx`).
    pub retry_success: i64,
    /// Requests failing (`status_code >= 400`).
    pub final_error: i64,
    /// HTTP 2xx count.
    pub status_2xx: i64,
    /// HTTP 4xx count.
    pub status_4xx: i64,
    /// HTTP 5xx count.
    pub status_5xx: i64,
    /// Other status codes (`< 200`, `3xx`, or `0`).
    pub status_other: i64,
}

/// Per-provider routing volume and success rate summary.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRoutingStat {
    /// Provider identifier.
    pub provider_id: String,
    /// Provider display name.
    pub provider_name: String,
    /// Total attempts routed to this provider.
    pub request_count: i64,
    /// Success rate percentage (`0.0..=100.0`).
    pub success_rate: f64,
    /// Failed attempt count.
    pub error_count: i64,
}

/// Named counter item for categorical distributions (e.g., `finish_reason`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedCount {
    /// Category name.
    pub name: String,
    /// Count in window.
    pub count: i64,
}

/// Streaming vs non-streaming request split.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamSplit {
    /// Streaming request count.
    pub stream_count: i64,
    /// Non-streaming request count.
    pub non_stream_count: i64,
}

/// Summary KPIs for the `routing` tab.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingSummary {
    /// Distinct matched route rule count.
    pub active_rules: i64,
    /// Percentage of requests succeeding on first attempt.
    pub first_try_success_rate: f64,
    /// Count of requests recovered via retry/fallback.
    pub retry_success_count: i64,
    /// Percentage of retried requests that succeeded.
    pub retry_recovery_rate: f64,
    /// Streaming request share percentage.
    pub stream_rate: f64,
}

/// Per-rule scheduling statistics for the `routing` main table.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteRuleStat {
    /// Route rule identifier.
    pub rule_id: String,
    /// Total matched attempts.
    pub request_count: i64,
    /// Traffic share percentage (`0.0..=100.0`).
    pub share_percent: f64,
    /// Distinct `(provider, model)` endpoints targeted by this rule.
    pub endpoint_count: i64,
    /// First-try success rate percentage.
    pub first_try_rate: f64,
    /// Fallback/retry trigger rate percentage.
    pub fallback_rate: f64,
    /// Mean routing script latency in milliseconds.
    pub avg_routing_ms: f64,
    /// Mean total request duration in milliseconds.
    pub avg_duration_ms: f64,
}

/// Call-model to target-model mapping frequency item.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallModelMappingStat {
    /// Consume-side call model ID.
    pub call_model_id: String,
    /// Target provider ID.
    pub provider_id: String,
    /// Target model ID.
    pub model_id: String,
    /// Target model display name.
    pub model_name: String,
    /// Request count.
    pub request_count: i64,
}

/// Response payload for `GET /api/v1/stats/monitoring/routing`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingMonitoringResponse {
    /// Shared metadata and filters.
    pub meta: MonitoringMeta,
    /// Window summary KPIs.
    pub summary: RoutingSummary,
    /// Ordered rule keys matching `RoutingBucket::rule_counts`.
    pub rule_series_keys: Vec<String>,
    /// Time-series routing, retry, and status buckets.
    pub buckets: Vec<RoutingBucket>,
    /// Per-rule scheduling statistics table.
    pub rule_stats: Vec<RouteRuleStat>,
    /// Per-provider volume and success rate comparison.
    pub provider_stats: Vec<ProviderRoutingStat>,
    /// Categorical `finish_reason` counts.
    pub finish_reasons: Vec<NamedCount>,
    /// Streaming vs non-streaming split.
    pub stream_split: StreamSplit,
    /// Attempt count distribution (`1次`, `2次`, `3次+`).
    pub attempt_distribution: Vec<NamedCount>,
    /// Call-model to target-model mapping top list.
    pub call_model_mappings: Vec<CallModelMappingStat>,
    /// Token accounting source distribution.
    pub token_sources: Vec<NamedCount>,
}

/// Summary KPIs for the `errors` (异常) tab.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorsSummary {
    /// Total requests in window.
    pub total_requests: i64,
    /// Total error requests (`status >= 400` or `< 200`).
    pub total_errors: i64,
    /// Overall error rate percentage.
    pub error_rate: f64,
    /// HTTP 429 rate-limit count.
    pub rate_limit_count: i64,
    /// HTTP 429 rate-limit percentage.
    pub rate_limit_rate: f64,
    /// 5xx / 502 / connection timeout count.
    pub timeout_or_5xx_count: i64,
    /// 5xx / timeout percentage.
    pub timeout_or_5xx_rate: f64,
    /// Interrupted SSE stream count.
    pub sse_interrupted_count: i64,
}

/// Time-bucketed error telemetry point for `GET /api/v1/stats/monitoring/errors`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorBucket {
    /// Formatted bucket timestamp label.
    pub label: String,
    /// Total requests in bucket.
    pub total_requests: i64,
    /// Total failed requests.
    pub error_count: i64,
    /// Error rate percentage.
    pub error_rate: f64,
    /// HTTP 429 count.
    pub status_429: i64,
    /// Other 4xx count.
    pub status_4xx_other: i64,
    /// HTTP 502 count.
    pub status_502: i64,
    /// Other 5xx count.
    pub status_5xx_other: i64,
    /// Mean duration of failed requests in milliseconds.
    pub avg_error_duration_ms: f64,
    /// Fallback/retry recovered successes.
    pub retry_recovered: i64,
    /// Final failed requests.
    pub final_error: i64,
}

/// Aggregated error detail row joining `request_payloads.error_message`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorDetailRow {
    /// Provider ID.
    pub provider_id: String,
    /// Provider display name.
    pub provider_name: String,
    /// Model ID.
    pub model_id: String,
    /// Model display name.
    pub model_name: String,
    /// Matched route rule ID.
    pub route_rule_id: String,
    /// HTTP status code.
    pub status_code: i32,
    /// Truncated error message snippet.
    pub error_snippet: String,
    /// Occurrence count.
    pub count: i64,
    /// Share of total errors percentage.
    pub share_percent: f64,
    /// Last occurrence ISO timestamp.
    pub last_seen: String,
}

/// Per-entity error count and rate summary.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorEntityStat {
    /// Entity ID.
    pub id: String,
    /// Entity display name.
    pub name: String,
    /// Total requests.
    pub total_requests: i64,
    /// Error count.
    pub error_count: i64,
    /// Error rate percentage.
    pub error_rate: f64,
}

/// Response payload for `GET /api/v1/stats/monitoring/errors`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorsMonitoringResponse {
    /// Shared metadata and filters.
    pub meta: MonitoringMeta,
    /// Window error summary KPIs.
    pub summary: ErrorsSummary,
    /// Time-series error buckets.
    pub buckets: Vec<ErrorBucket>,
    /// Aggregated error details table.
    pub error_details: Vec<ErrorDetailRow>,
    /// Error counts by provider.
    pub by_provider: Vec<ErrorEntityStat>,
    /// Error counts by model.
    pub by_model: Vec<ErrorEntityStat>,
    /// Error counts by project.
    pub by_project: Vec<ErrorEntityStat>,
    /// Error status code category distribution.
    pub status_breakdown: Vec<NamedCount>,
}

/// Series metadata for stacked cost chart.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostSeriesMeta {
    /// Series key (`provider/model` or `other`).
    pub key: String,
    /// Display label.
    pub name: String,
}

/// One time-bucketed point for the `cost` monitoring dimension.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostBucket {
    /// Formatted bucket timestamp label.
    pub label: String,
    /// Total converted cost in display currency.
    pub total_amount: f64,
    /// Number of unpriced requests in this bucket.
    pub unpriced_count: i64,
    /// Number of billing script errors in this bucket.
    pub script_error_count: i64,
    /// Cost breakdown by top models + `"other"`.
    pub by_model: BTreeMap<String, f64>,
    /// Cost breakdown by top projects + `"other"`.
    pub by_project: BTreeMap<String, f64>,
    /// Input token cost component.
    pub input_amount: f64,
    /// Output token cost component.
    pub output_amount: f64,
    /// Cache read cost component.
    pub cache_read_amount: f64,
    /// Cache write cost component.
    pub cache_write_amount: f64,
    /// Other/storage/flat cost component.
    pub other_amount: f64,
    /// Effective unit cost per 1M total tokens.
    pub cost_per_1m_tokens: f64,
    /// Average cost per priced request.
    pub avg_cost_per_request: f64,
}

/// Ranked project, provider, or model cost summary item.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostRankItem {
    /// Project, provider, or model identifier.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Converted total cost.
    pub amount: f64,
    /// Unpriced requests for this entity.
    pub unpriced_count: i64,
    /// Total requests for this entity.
    pub request_count: i64,
}

/// Detailed cost breakdown row for the `cost` main accounting table.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostDetailRow {
    /// Grouping dimension (`"model"`, `"project"`, or `"provider"`).
    pub group_by: String,
    /// Entity ID.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Total converted cost.
    pub total_amount: f64,
    /// Share of dimension total percentage.
    pub share_percent: f64,
    /// Input cost component.
    pub input_amount: f64,
    /// Output cost component.
    pub output_amount: f64,
    /// Cache read + write cost component.
    pub cache_amount: f64,
    /// Other/storage cost component.
    pub other_amount: f64,
    /// Effective cost per 1M total tokens.
    pub cost_per_1m_tokens: f64,
    /// Total requests.
    pub request_count: i64,
    /// Unpriced requests.
    pub unpriced_count: i64,
}

/// Raw currency total item.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrencyTotal {
    /// 3-letter currency code.
    pub currency: String,
    /// Sum in original currency.
    pub amount: f64,
}

/// Summary KPIs for the `cost` tab.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostSummary {
    /// Total converted spend.
    pub total_amount: f64,
    /// Overall unit cost per 1M tokens.
    pub cost_per_1m_tokens: f64,
    /// Overall average cost per priced request.
    pub avg_cost_per_request: f64,
    /// Total priced requests.
    pub priced_count: i64,
    /// Total unpriced requests.
    pub unpriced_count: i64,
    /// Total billing script error count.
    pub script_error_count: i64,
    /// Pricing coverage percentage (`0.0..=100.0`).
    pub coverage_rate: f64,
    /// Per-currency raw totals.
    pub currency_totals: Vec<CurrencyTotal>,
}

/// Aggregated 5-bucket cost components over the active window.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostComponentTotals {
    /// Input cost sum.
    pub input_amount: f64,
    /// Output cost sum.
    pub output_amount: f64,
    /// Cache read cost sum.
    pub cache_read_amount: f64,
    /// Cache write cost sum.
    pub cache_write_amount: f64,
    /// Other/storage cost sum.
    pub other_amount: f64,
}

/// Response payload for `GET /api/v1/stats/monitoring/cost`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostMonitoringResponse {
    /// Shared metadata and filters.
    pub meta: MonitoringMeta,
    /// Target currency code used for chart values (if convertible).
    pub currency: Option<String>,
    /// Window cost summary KPIs.
    pub summary: CostSummary,
    /// Window 5-bucket component totals.
    pub component_totals: CostComponentTotals,
    /// Ordered series keys for stacked model cost chart.
    pub series_keys: Vec<CostSeriesMeta>,
    /// Ordered series keys for stacked project cost chart.
    pub project_series_keys: Vec<CostSeriesMeta>,
    /// Time-series cost, component breakdown, and unit efficiency buckets.
    pub buckets: Vec<CostBucket>,
    /// Top-10 projects by spend.
    pub rank_by_project: Vec<CostRankItem>,
    /// Top-10 models by spend.
    pub rank_by_model: Vec<CostRankItem>,
    /// Top-10 providers by spend.
    pub rank_by_provider: Vec<CostRankItem>,
    /// Billing status counts (`priced`, `unpriced`, `script_error`, etc.).
    pub billing_status_counts: Vec<NamedCount>,
    /// Full accounting breakdown rows across models, projects, and providers.
    pub detail_rows: Vec<CostDetailRow>,
}

/// Derives a deterministic slug ID from a provider display name when `id` is omitted.
#[must_use]
pub fn derive_provider_slug(name: &str) -> String {
    let trimmed = name.trim();
    match trimmed {
        "深度求索" => return "deepseek".to_string(),
        "阿里云百炼" => return "bailian".to_string(),
        _ => {}
    }

    let mut out = String::new();
    let mut prev_dash = false;
    for ch in trimmed.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if (ch == '-' || ch == '_' || ch == ' ') && !prev_dash && !out.is_empty() {
            out.push('-');
            prev_dash = true;
        }
    }
    let cleaned = out.trim_matches('-').to_string();
    if cleaned.is_empty() {
        // Stable deterministic hash fallback for non-ASCII provider names.
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for byte in trimmed.as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0100_0000_01b3);
        }
        format!("provider-{hash:08x}")
    } else {
        cleaned
    }
}

/// Infers a `LobeHub` SVG icon slug from provider ID/name when `icon` is omitted.
#[must_use]
pub fn infer_provider_icon(provider_id: &str, provider_name: &str) -> String {
    let probe = format!("{provider_id} {provider_name}").to_ascii_lowercase();
    if probe.contains("deepseek") || provider_name.contains("深度求索") {
        "deepseek-color".to_string()
    } else if probe.contains("opencode") {
        "opencode".to_string()
    } else if probe.contains("bailian")
        || probe.contains("aliyun")
        || probe.contains("alibaba")
        || provider_name.contains("百炼")
    {
        "alibabacloud-color".to_string()
    } else if probe.contains("antigravity") || probe.contains("gemini") {
        "gemini-color".to_string()
    } else if probe.contains("codex") || probe.contains("openai") {
        "openai".to_string()
    } else if probe.contains("oproxy") || probe.contains("claude") {
        "claude-color".to_string()
    } else if probe.contains("lonnet") {
        "qwen-color".to_string()
    } else {
        provider_id.to_ascii_lowercase()
    }
}

/// Infers a `LobeHub` SVG icon slug from model ID/name and fallback provider icon.
#[must_use]
pub fn infer_model_icon(model_id: &str, model_name: &str, fallback_icon: &str) -> String {
    let probe = format!("{model_id} {model_name}").to_ascii_lowercase();
    if probe.contains("deepseek") {
        "deepseek-color".to_string()
    } else if probe.contains("qwen") {
        "qwen-color".to_string()
    } else if probe.contains("kimi") {
        "kimi-color".to_string()
    } else if probe.contains("minimax") {
        "minimax-color".to_string()
    } else if probe.contains("glm") || probe.contains("zhipu") {
        "zhipu-color".to_string()
    } else if probe.contains("mimo") || probe.contains("xiaomi") {
        "xiaomi-color".to_string()
    } else if probe.starts_with("hy") || probe.contains(" hy") || probe.contains("hunyuan") {
        "hunyuan-color".to_string()
    } else if probe.contains("gpt") || probe.contains("codex") || probe.starts_with("o3") {
        "openai".to_string()
    } else if probe.contains("grok") {
        "grok".to_string()
    } else if probe.contains("gemini") {
        "gemini-color".to_string()
    } else if probe.contains("claude") {
        "claude-color".to_string()
    } else if probe.contains("longcat") {
        "longcat-color".to_string()
    } else {
        fallback_icon.to_string()
    }
}

/// Normalizes an upstream base URL into a `/chat/completions` endpoint without
/// duplicating `/v1` when an explicit `/vN` version suffix is already present.
#[must_use]
pub fn normalize_chat_completions_url(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    } else if has_version_segment_suffix(trimmed) {
        format!("{trimmed}/chat/completions")
    } else {
        format!("{trimmed}/v1/chat/completions")
    }
}

/// Checks if a URL ends with `/v<digits>` (e.g., `/v1`, `/api/v3`, `/api/paas/v4`).
fn has_version_segment_suffix(url: &str) -> bool {
    let Some((_, last)) = url.rsplit_once('/') else {
        return false;
    };
    let Some(digits) = last.strip_prefix('v') else {
        return false;
    };
    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}

/// Extracts pre-computed `RequestSignals` from an OpenAI-compatible JSON payload.
#[must_use]
pub fn extract_request_signals(body: &Map<String, Value>) -> RequestSignals {
    let is_stream = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let has_tools = body
        .get("tools")
        .and_then(Value::as_array)
        .is_some_and(|arr| !arr.is_empty());

    let messages = body.get("messages").and_then(Value::as_array);
    let message_count = messages.map_or(0, Vec::len);

    let mut has_vision_images = false;
    let mut estimated_input_chars = 0usize;

    if let Some(items) = messages {
        for msg in items {
            if let Some(content) = msg.get("content") {
                inspect_content_value(content, &mut has_vision_images, &mut estimated_input_chars);
            }
            if let Some(tool_calls) = msg.get("tool_calls") {
                estimated_input_chars =
                    estimated_input_chars.saturating_add(tool_calls.to_string().len());
            }
        }
    }

    RequestSignals {
        is_stream,
        has_vision_images,
        has_tools,
        message_count,
        estimated_input_chars,
    }
}

/// Recursively traverses a message `content` field to count chars and detect vision image parts.
fn inspect_content_value(
    value: &Value,
    has_vision_images: &mut bool,
    estimated_input_chars: &mut usize,
) {
    match value {
        Value::String(text) => {
            *estimated_input_chars = estimated_input_chars.saturating_add(text.chars().count());
        }
        Value::Array(parts) => {
            for part in parts {
                if let Some(part_type) = part.get("type").and_then(Value::as_str)
                    && (part_type == "image_url" || part_type == "input_image")
                {
                    *has_vision_images = true;
                }
                if part.get("image_url").is_some() {
                    *has_vision_images = true;
                }
                if let Some(text) = part.get("text").and_then(Value::as_str) {
                    *estimated_input_chars =
                        estimated_input_chars.saturating_add(text.chars().count());
                }
            }
        }
        _ => {}
    }
}

impl ProviderConfig {
    /// Converts into sanitized `EntityInfo` (without `apiKey` or `scripts`) for stages ①..③ & candidates.
    #[must_use]
    pub fn to_entity_info(&self) -> EntityInfo {
        EntityInfo {
            id: self.id.clone(),
            name: self.name.clone(),
            icon: self.icon.clone(),
            tags: self.compiled.tags.clone(),
            meta: self.compiled.meta.clone(),
        }
    }

    /// Converts into `ProviderInfo` (including `apiKey`) for stages ④, ⑤, and `onBilling`.
    #[must_use]
    pub fn to_provider_info(&self) -> ProviderInfo {
        ProviderInfo {
            id: self.id.clone(),
            name: self.name.clone(),
            icon: self.icon.clone(),
            tags: self.compiled.tags.clone(),
            meta: self.compiled.meta.clone(),
            api_key: self.api_key.clone(),
        }
    }
}

impl ModelConfig {
    /// Converts into `EntityInfo` for `ScriptContext`, `CandidateItem`, and `BillingContext`.
    #[must_use]
    pub fn to_entity_info(&self) -> EntityInfo {
        EntityInfo {
            id: self.id.clone(),
            name: self.name.clone(),
            icon: self.icon.clone(),
            tags: self.compiled.tags.clone(),
            meta: self.compiled.meta.clone(),
        }
    }
}

impl ProjectConfig {
    /// Converts into sanitized `EntityInfo` (without `apiKey` or `scripts`).
    #[must_use]
    pub fn to_entity_info(&self) -> EntityInfo {
        EntityInfo {
            id: self.id.clone(),
            name: self.name.clone(),
            icon: self.icon.clone(),
            tags: self.compiled.tags.clone(),
            meta: self.compiled.meta.clone(),
        }
    }
}

impl CallModelConfig {
    /// Converts into `EntityInfo` for `ScriptContext` and `BillingContext`.
    #[must_use]
    pub fn to_entity_info(&self) -> EntityInfo {
        EntityInfo {
            id: self.id.clone(),
            name: self.name.clone(),
            icon: self.icon.clone(),
            tags: self.compiled.tags.clone(),
            meta: self.compiled.meta.clone(),
        }
    }
}

impl RouteRuleConfig {
    /// Converts into `EntityInfo` for `ctx.routeInfo` during stage ③.
    #[must_use]
    pub fn to_entity_info(&self) -> EntityInfo {
        EntityInfo {
            id: self.id.clone(),
            name: self.name.clone(),
            icon: self.icon.clone(),
            tags: self.compiled.tags.clone(),
            meta: self.compiled.meta.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_normalization_handles_version_variants() {
        assert_eq!(
            normalize_chat_completions_url("https://api.deepseek.com"),
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(
            normalize_chat_completions_url("https://api.deepseek.com/"),
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(
            normalize_chat_completions_url("https://opencode.ai/zen/go/v1"),
            "https://opencode.ai/zen/go/v1/chat/completions"
        );
        assert_eq!(
            normalize_chat_completions_url("https://ark.cn-beijing.volces.com/api/v3"),
            "https://ark.cn-beijing.volces.com/api/v3/chat/completions"
        );
        assert_eq!(
            normalize_chat_completions_url("https://open.bigmodel.cn/api/paas/v4/"),
            "https://open.bigmodel.cn/api/paas/v4/chat/completions"
        );
        assert_eq!(
            normalize_chat_completions_url("http://127.0.0.1:8317/v1/chat/completions"),
            "http://127.0.0.1:8317/v1/chat/completions"
        );
    }

    #[test]
    fn provider_slug_and_icon_derivation_work() {
        assert_eq!(derive_provider_slug("深度求索"), "deepseek");
        assert_eq!(derive_provider_slug("阿里云百炼"), "bailian");
        assert_eq!(derive_provider_slug("Opencode"), "opencode");

        assert_eq!(
            infer_provider_icon("deepseek", "深度求索"),
            "deepseek-color"
        );
        assert_eq!(
            infer_model_icon("qwen3.8-max", "Qwen3.8 Max", "opencode"),
            "qwen-color"
        );
        assert_eq!(
            infer_model_icon("gpt-6.1-sol", "GPT 6.1 Sol", "codex"),
            "openai"
        );
    }

    #[test]
    fn script_context_strips_project_key_and_provider_sanitized_info() {
        let project = ProjectConfig {
            id: "coding".to_string(),
            name: "Coding".to_string(),
            icon: "githubcopilot".to_string(),
            enabled: true,
            api_key: "secret-project-key".to_string(),
            scripts: Vec::new(),
            compiled: CompiledScriptChain::default(),
            call_models: Vec::new(),
        };
        let meta_json = serde_json::to_string(&project.to_entity_info()).unwrap_or_default();
        assert!(!meta_json.contains("secret-project-key"));

        let provider = ProviderConfig {
            id: "deepseek".to_string(),
            name: "DeepSeek".to_string(),
            icon: "deepseek-color".to_string(),
            enabled: true,
            api_key: "sk-secret-provider".to_string(),
            scripts: Vec::new(),
            compiled: CompiledScriptChain::default(),
            models: Vec::new(),
        };
        let sanitized = serde_json::to_string(&provider.to_entity_info()).unwrap_or_default();
        assert!(!sanitized.contains("sk-secret-provider"));

        let full = serde_json::to_string(&provider.to_provider_info()).unwrap_or_default();
        assert!(full.contains("sk-secret-provider"));
    }
}
