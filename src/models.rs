//! Domain models, JSON configuration structs, 1:1 `ScriptContext` contracts, and telemetry DTOs.

use std::collections::BTreeMap;
use std::fmt;
use std::path::Path;

use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use uuid::Uuid;

/// Flexible script source supporting inline string, array of lines, or `@file:<path>`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum ScriptSource {
    /// Single string or `@file:<path>` directive.
    Single(String),
    /// Multi-line string array joined with `\n`.
    Lines(Vec<String>),
}

impl ScriptSource {
    /// Converts the raw JSON script representation into normalized source code,
    /// reading external files when prefixed with `@file:`.
    ///
    /// # Errors
    /// Returns an error if an `@file:` reference cannot be read.
    pub fn resolve(&self, base_dir: &Path) -> anyhow::Result<String> {
        match self {
            Self::Single(text) => {
                let trimmed = text.trim();
                if let Some(rel_path) = trimmed.strip_prefix("@file:") {
                    let target = Path::new(rel_path.trim());
                    let resolved = if target.is_absolute() {
                        target.to_path_buf()
                    } else {
                        base_dir.join(target)
                    };
                    std::fs::read_to_string(&resolved).map_err(|err| {
                        anyhow::anyhow!(
                            "failed to load @file script '{}': {err}",
                            resolved.display()
                        )
                    })
                } else {
                    Ok(text.clone())
                }
            }
            Self::Lines(lines) => Ok(lines.join("\n")),
        }
    }
}

/// Version-tolerant wrapper supporting both legacy top-level arrays (`v1`) and
/// explicit `{ "schemaVersion": ..., "items": [...] }` objects.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum VersionedList<T> {
    /// Legacy v1 bare JSON array.
    Bare(Vec<T>),
    /// Versioned wrapper object.
    Wrapped {
        /// Schema version number (defaults to 1 if omitted).
        #[serde(rename = "schemaVersion", default = "default_schema_version")]
        schema_version: u32,
        /// Configuration records.
        items: Vec<T>,
    },
}

/// Default schema version when omitted in versioned wrapper files.
const fn default_schema_version() -> u32 {
    1
}

impl<T> VersionedList<T> {
    /// Extracts the inner list and its detected schema version.
    #[must_use]
    pub fn into_items(self) -> (u32, Vec<T>) {
        match self {
            Self::Bare(items) => (1, items),
            Self::Wrapped {
                schema_version,
                items,
            } => (schema_version, items),
        }
    }
}

/// Raw supply-side provider object deserialized from `chatLanguageModels.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawProviderConfig {
    /// Optional stable provider identifier; derived from `name` when absent.
    #[serde(default)]
    pub id: Option<String>,
    /// Display name of the provider.
    pub name: String,
    /// Optional vendor filter from VS Code `chatLanguageModels.json`.
    #[serde(default)]
    pub vendor: Option<String>,
    /// Optional API type filter from VS Code `chatLanguageModels.json`.
    #[serde(default)]
    pub api_type: Option<String>,
    /// Optional plaintext or placeholder API key.
    #[serde(default)]
    pub api_key: String,
    /// Optional `LobeHub` icon slug.
    #[serde(default)]
    pub icon: Option<String>,
    /// Optional Stage ⑤ provider script.
    #[serde(default)]
    pub script: Option<ScriptSource>,
    /// Configured models under this provider.
    #[serde(default)]
    pub models: Vec<RawModelConfig>,
}

/// Raw supply-side model object deserialized from `chatLanguageModels.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawModelConfig {
    /// Model identifier sent to upstream.
    pub id: String,
    /// Human-readable display name.
    pub name: String,
    /// Optional `LobeHub` icon slug.
    #[serde(default)]
    pub icon: Option<String>,
    /// Upstream base or completions endpoint URL.
    pub url: String,
    /// Supported `reasoning_effort` values if any.
    #[serde(default)]
    pub supports_reasoning_effort: Option<Vec<String>>,
    /// Whether the model supports tool/function calling.
    #[serde(default)]
    pub tool_calling: Option<bool>,
    /// Whether the model supports vision/image inputs.
    #[serde(default)]
    pub vision: Option<bool>,
    /// Whether the model supports thinking/reasoning.
    #[serde(default)]
    pub thinking: Option<bool>,
    /// Whether the model supports SSE streaming.
    #[serde(default)]
    pub streaming: Option<bool>,
    /// Maximum context input tokens.
    #[serde(default)]
    pub max_input_tokens: Option<u64>,
    /// Maximum completion output tokens.
    #[serde(default)]
    pub max_output_tokens: Option<u64>,
    /// Optional Stage ④ model script.
    #[serde(default)]
    pub script: Option<ScriptSource>,
}

/// Normalized supply-side provider configuration loaded into `RuntimeCatalog`.
#[derive(Debug, Clone)]
pub struct ProviderConfig {
    /// Optional VS Code provider kind.
    pub vendor: Option<String>,
    /// Optional VS Code API kind.
    pub api_type: Option<String>,
    /// Stable provider identifier.
    pub id: String,
    /// Human-readable display name.
    pub name: String,
    /// Resolved `LobeHub` icon slug.
    pub icon: String,
    /// Upstream bearer API key (kept out of `ScriptContext`).
    pub api_key: String,
    /// Resolved Stage ⑤ script source if configured.
    pub script: Option<String>,
    /// Normalized models keyed in order.
    pub models: Vec<ModelConfig>,
}

/// Normalized supply-side model configuration loaded into `RuntimeCatalog`.
#[derive(Debug, Clone)]
pub struct ModelConfig {
    /// Upstream model identifier.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Resolved `LobeHub` icon slug.
    pub icon: String,
    /// Upstream URL as configured.
    pub url: String,
    /// Supported reasoning effort modes.
    pub supports_reasoning_effort: Option<Vec<String>>,
    /// Tool calling support flag.
    pub tool_calling: Option<bool>,
    /// Vision support flag.
    pub vision: Option<bool>,
    /// Thinking support flag.
    pub thinking: Option<bool>,
    /// Streaming support flag.
    pub streaming: Option<bool>,
    /// Max input token limit.
    pub max_input_tokens: Option<u64>,
    /// Max output token limit.
    pub max_output_tokens: Option<u64>,
    /// Resolved Stage ④ script source if configured.
    pub script: Option<String>,
}

/// Raw consume-side project deserialized from `projects.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawProjectConfig {
    /// Project identifier.
    pub id: String,
    /// Project display name.
    pub name: String,
    /// Optional gateway bearer key required for this project.
    #[serde(default)]
    pub api_key: Option<String>,
    /// Optional `LobeHub` icon slug.
    #[serde(default)]
    pub icon: Option<String>,
    /// Arbitrary metadata exposed as `ctx.project.meta`.
    #[serde(default)]
    pub meta: Map<String, Value>,
    /// Optional Stage ① project script.
    #[serde(default)]
    pub script: Option<ScriptSource>,
    /// Configured virtual/call models under this project.
    #[serde(default)]
    pub call_models: Vec<RawCallModelConfig>,
}

/// Raw consume-side call model deserialized from `projects.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawCallModelConfig {
    /// Call model identifier clients send as `model` (`"*"` is not allowed).
    pub id: String,
    /// Display name.
    pub name: String,
    /// Optional `LobeHub` icon slug.
    #[serde(default)]
    pub icon: Option<String>,
    /// Arbitrary metadata exposed as `ctx.callModel.meta`.
    #[serde(default)]
    pub meta: Map<String, Value>,
    /// Optional Stage ② call-model script.
    #[serde(default)]
    pub script: Option<ScriptSource>,
}

/// Normalized consume-side project configuration.
#[derive(Debug, Clone)]
pub struct ProjectConfig {
    /// Project identifier.
    pub id: String,
    /// Project display name.
    pub name: String,
    /// Optional gateway authentication key (stripped before entering `ScriptContext`).
    pub api_key: Option<String>,
    /// Resolved icon slug.
    pub icon: String,
    /// Metadata dictionary exposed to scripts.
    pub meta: Map<String, Value>,
    /// Resolved Stage ① script source if configured.
    pub script: Option<String>,
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
    /// Resolved icon slug.
    pub icon: String,
    /// Metadata dictionary exposed to scripts.
    pub meta: Map<String, Value>,
    /// Resolved Stage ② script source if configured.
    pub script: Option<String>,
}

/// Raw routing rule deserialized from `routes.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawRouteRuleConfig {
    /// Unique rule identifier.
    pub id: String,
    /// Human-readable rule name.
    pub name: String,
    /// Whether this rule participates in matching.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Matching priority (higher wins).
    #[serde(default)]
    pub priority: i32,
    /// Match predicates (`projectIds`, `callModelIds`).
    #[serde(rename = "match")]
    pub match_rule: RouteMatchConfig,
    /// Candidate pool allow/deny filter patterns.
    #[serde(default)]
    pub candidates: RouteCandidatesFilter,
    /// Optional static primary endpoint.
    #[serde(default)]
    pub target: Option<RouteEndpoint>,
    /// Optional static fallback endpoints.
    #[serde(default)]
    pub fallbacks: Vec<RouteEndpoint>,
    /// Whether to rewrite response `model` field back to `ctx.callModel.id`.
    #[serde(default)]
    pub rewrite_response_model: bool,
    /// Optional Stage ③ routing script.
    #[serde(default)]
    pub script: Option<ScriptSource>,
}

/// Helper default returning `true` for serde defaults.
const fn default_true() -> bool {
    true
}

/// Matching predicates for a routing rule.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RouteMatchConfig {
    /// Project IDs matched by this rule (`"*"` matches any).
    #[serde(default)]
    pub project_ids: Vec<String>,
    /// Call model IDs matched by this rule (`"*"` matches any).
    #[serde(default)]
    pub call_model_ids: Vec<String>,
}

/// Candidate allow/deny glob patterns on `providerId/modelId`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteCandidatesFilter {
    /// Allowed candidate patterns (defaults to `["*"]`).
    #[serde(default = "default_allow_all")]
    pub allow: Vec<String>,
    /// Denied candidate patterns.
    #[serde(default)]
    pub deny: Vec<String>,
}

impl Default for RouteCandidatesFilter {
    fn default() -> Self {
        Self {
            allow: default_allow_all(),
            deny: Vec::new(),
        }
    }
}

/// Default wildcard allow list.
fn default_allow_all() -> Vec<String> {
    vec!["*".to_string()]
}

/// Normalized routing rule stored in `RuntimeCatalog`.
#[derive(Debug, Clone)]
pub struct RouteRuleConfig {
    /// Unique rule identifier (`ctx.route.ruleId`).
    pub id: String,
    /// Rule display name.
    pub name: String,
    /// Enabled flag.
    pub enabled: bool,
    /// Rule priority (higher evaluated first).
    pub priority: i32,
    /// Match condition.
    pub match_rule: RouteMatchConfig,
    /// Candidate filter configuration.
    pub candidates: RouteCandidatesFilter,
    /// Optional default target endpoint.
    pub target: Option<RouteEndpoint>,
    /// Optional default fallback endpoints.
    pub fallbacks: Vec<RouteEndpoint>,
    /// Response model rewrite flag.
    pub rewrite_response_model: bool,
    /// Resolved Stage ③ script source if configured.
    pub script: Option<String>,
}

/// Five unidirectional script execution stages matching `linguist.d.ts`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ScriptStage {
    /// ① Project-level outbound script.
    Project,
    /// ② Call-model-level outbound script.
    CallModel,
    /// ③ Route selection outbound script.
    Route,
    /// ④ Supply model outbound script.
    Model,
    /// ⑤ Supply provider outbound script.
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

/// Unified 9-key context passed to and mutated by scripts across stages ①..⑤.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptContext {
    /// 1. Current execution stage (read-only).
    pub stage: ScriptStage,
    /// 2. Consume-side project metadata (read-only, sanitized).
    pub project: ProjectMeta,
    /// 3. Consume-side call model metadata (read-only).
    pub call_model: CallModelMeta,
    /// 4. Supply-side provider metadata (read-only, populated for stages ④ and ⑤).
    pub provider: Option<ProviderMeta>,
    /// 5. Supply-side model metadata (read-only, populated for stages ④ and ⑤).
    pub model: Option<ModelMeta>,
    /// 6. Route control state.
    pub route: RouteState,
    /// 7. Mutable outbound HTTP request state.
    pub request: RequestState,
    /// 8. Cross-stage shared key-value bag.
    pub state: Map<String, Value>,
    /// 9. Immediate request rejection directive.
    pub reject: Option<RejectDirective>,
}

/// Sanitized project descriptor exposed as `ctx.project`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMeta {
    /// Project ID.
    pub id: String,
    /// Project display name.
    pub name: String,
    /// Optional `LobeHub` icon slug.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Project metadata map.
    pub meta: Map<String, Value>,
}

/// Sanitized call-model descriptor exposed as `ctx.callModel`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CallModelMeta {
    /// Call model ID (requested `model` string).
    pub id: String,
    /// Call model display name.
    pub name: String,
    /// Optional `LobeHub` icon slug.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Call model metadata map.
    pub meta: Map<String, Value>,
}

/// Sanitized provider descriptor exposed as `ctx.provider` and `c.provider`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderMeta {
    /// Provider ID.
    pub id: String,
    /// Provider display name.
    pub name: String,
    /// Optional `LobeHub` icon slug.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

/// Sanitized supply model descriptor exposed as `ctx.model` and `c.model`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelMeta {
    /// Upstream model ID.
    pub id: String,
    /// Model display name.
    pub name: String,
    /// Optional `LobeHub` icon slug.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Configured upstream URL.
    pub url: String,
    /// Supported `reasoning_effort` levels.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_reasoning_effort: Option<Vec<String>>,
    /// Tool calling support flag.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calling: Option<bool>,
    /// Vision support flag.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vision: Option<bool>,
    /// Thinking support flag.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<bool>,
    /// Streaming support flag.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub streaming: Option<bool>,
    /// Maximum input tokens.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_input_tokens: Option<u64>,
    /// Maximum output tokens.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u64>,
}

/// Route state exposed as `ctx.route`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteState {
    /// Matched rule ID (`routes.json[].id`).
    pub rule_id: String,
    /// Candidate pool (filterable in stages ①/②, ranked in ③).
    pub candidates: Vec<CandidateItem>,
    /// Selected primary target.
    pub target: Option<RouteEndpoint>,
    /// Ordered fallback targets.
    pub fallbacks: Vec<RouteEndpoint>,
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

/// Reject invalid retry counts in both static routes and script-generated endpoints.
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
    pub provider: ProviderMeta,
    /// Supply-side model descriptor.
    pub model: ModelMeta,
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
    /// Outbound HTTP URL (populated for stages ④ and ⑤).
    pub url: String,
    /// Mutable outbound request headers.
    pub headers: BTreeMap<String, String>,
    /// Mutable `OpenAI` chat completions JSON body.
    pub body: Map<String, Value>,
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

/// Completed request log record sent asynchronously to PostgreSQL.
#[derive(Debug, Clone)]
pub struct RequestLogRecord {
    /// Unique UID for this attempt.
    pub request_uid: Uuid,
    /// Root request UID shared across primary + fallback attempts.
    pub parent_request_uid: Option<Uuid>,
    /// 1-based attempt index.
    pub attempt_index: i16,
    /// Timestamp when the request finished.
    pub created_at: DateTime<Utc>,
    /// Presence-preserving Chat Completions usage for billing.
    pub billing_usage: Option<crate::billing::BillingUsage>,
    /// Price and target captured at the start of this upstream attempt.
    pub billing: crate::billing::AttemptBilling,
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
    /// Reasoning tokens.
    pub reasoning_tokens: i64,
    /// Total tokens.
    pub total_tokens: i64,
    /// TTFT in milliseconds.
    pub ttft_ms: f64,
    /// Total duration in milliseconds.
    pub total_duration_ms: f64,
    /// Net decode tokens per second.
    pub decode_tps: f64,
    /// End-to-end tokens per second.
    pub e2e_tps: f64,
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
/// duplicating `/v1` when already present.
#[must_use]
pub fn normalize_chat_completions_url(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    } else if trimmed.ends_with("/v1") {
        format!("{trimmed}/chat/completions")
    } else {
        format!("{trimmed}/v1/chat/completions")
    }
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
    /// Converts into sanitized `ProviderMeta` for `ScriptContext` (without `apiKey` or `script`).
    #[must_use]
    pub fn to_meta(&self) -> ProviderMeta {
        ProviderMeta {
            id: self.id.clone(),
            name: self.name.clone(),
            icon: Some(self.icon.clone()),
        }
    }
}

impl ModelConfig {
    /// Converts into sanitized `ModelMeta` for `ScriptContext` (without `script`).
    #[must_use]
    pub fn to_meta(&self) -> ModelMeta {
        ModelMeta {
            id: self.id.clone(),
            name: self.name.clone(),
            icon: Some(self.icon.clone()),
            url: self.url.clone(),
            supports_reasoning_effort: self.supports_reasoning_effort.clone(),
            tool_calling: self.tool_calling,
            vision: self.vision,
            thinking: self.thinking,
            streaming: self.streaming,
            max_input_tokens: self.max_input_tokens,
            max_output_tokens: self.max_output_tokens,
        }
    }
}

impl ProjectConfig {
    /// Converts into sanitized `ProjectMeta` for `ScriptContext` (without `apiKey` or `script`).
    #[must_use]
    pub fn to_meta(&self) -> ProjectMeta {
        ProjectMeta {
            id: self.id.clone(),
            name: self.name.clone(),
            icon: Some(self.icon.clone()),
            meta: self.meta.clone(),
        }
    }
}

impl CallModelConfig {
    /// Converts into sanitized `CallModelMeta` for `ScriptContext` (without `script`).
    #[must_use]
    pub fn to_meta(&self) -> CallModelMeta {
        CallModelMeta {
            id: self.id.clone(),
            name: self.name.clone(),
            icon: Some(self.icon.clone()),
            meta: self.meta.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_normalization_handles_v1_variants() {
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
            normalize_chat_completions_url("https://opencode.ai/zen/go/v1/"),
            "https://opencode.ai/zen/go/v1/chat/completions"
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
        assert_eq!(derive_provider_slug("Lonnet's"), "lonnets");
        assert_eq!(derive_provider_slug("Antigravity"), "antigravity");
        assert_eq!(derive_provider_slug("Codex"), "codex");

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
    fn script_context_strips_secrets() {
        let project = ProjectConfig {
            id: "coding".to_string(),
            name: "Coding".to_string(),
            api_key: Some("secret-project-key".to_string()),
            icon: "githubcopilot".to_string(),
            meta: Map::new(),
            script: Some("ctx.state.a = 1;".to_string()),
            call_models: Vec::new(),
        };
        let meta_json = serde_json::to_string(&project.to_meta()).unwrap_or_default();
        assert!(!meta_json.contains("secret-project-key"));
        assert!(!meta_json.contains("ctx.state.a"));

        let provider = ProviderConfig {
            vendor: None,
            api_type: None,
            id: "deepseek".to_string(),
            name: "DeepSeek".to_string(),
            icon: "deepseek-color".to_string(),
            api_key: "sk-secret-provider".to_string(),
            script: Some("ctx.request.headers.x = '1';".to_string()),
            models: Vec::new(),
        };
        let p_json = serde_json::to_string(&provider.to_meta()).unwrap_or_default();
        assert!(!p_json.contains("sk-secret-provider"));
        assert!(!p_json.contains("ctx.request.headers"));
    }
}
