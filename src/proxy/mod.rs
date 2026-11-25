//! OpenAI-compatible HTTP gateway endpoints (`/model/{project_id}/v1/...`), project
//! authentication, fallback execution, and zero-hook streaming.

pub mod stream_inspector;

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::Json;
use axum::Router;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use chrono::Utc;
use reqwest::header::CONTENT_TYPE;
use serde_json::{Map, Value, json};
use tracing::{info, warn};
use uuid::Uuid;

use crate::catalog::RuntimeCatalog;
use crate::metrics_cache::MetricSample;
use crate::models::{RequestLogRecord, ScriptContext};
use crate::proxy::stream_inspector::{
    CompletionCallback, InspectedByteStream, InspectionMetadata, StreamTelemetryTracker,
};
use crate::script_engine::pipeline::{
    RoutingPlan, StageOutcome, prepare_attempt_context, run_routing_stages,
};
use crate::state::AppState;

/// Registers project-scoped OpenAI-compatible proxy endpoints and `/healthz` on the Axum router.
///
/// The only model endpoints are `/model/{project_id}/v1/models` and
/// `/model/{project_id}/v1/chat/completions`.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/healthz", get(healthz_handler))
        .route(
            "/model/{project_id}/v1/chat/completions",
            post(project_chat_completions),
        )
        .route("/model/{project_id}/v1/models", get(project_list_models))
}

/// Service and database readiness endpoint used by deployments and monitoring.
async fn healthz_handler(State(state): State<AppState>) -> Response {
    if let Some(pool) = &state.db_pool {
        match sqlx::query("SELECT 1").execute(pool).await {
            Ok(_) => (
                StatusCode::OK,
                Json(json!({ "status": "ok", "service": "linguist", "database": "ok" })),
            )
                .into_response(),
            Err(err) => (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({
                    "status": "degraded",
                    "service": "linguist",
                    "database": format!("error: {err}")
                })),
            )
                .into_response(),
        }
    } else {
        (
            StatusCode::OK,
            Json(json!({ "status": "ok", "service": "linguist", "database": "disabled" })),
        )
            .into_response()
    }
}

/// Project-scoped `/model/{project_id}/v1/models` handler.
async fn project_list_models(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let catalog = state.catalog.load_full();
    if let Some(err_resp) = verify_project_auth(&catalog, &project_id, &headers) {
        return err_resp;
    }
    let models = catalog.list_openai_models(&project_id);
    Json(json!({ "object": "list", "data": models })).into_response()
}

/// Project-scoped `/model/{project_id}/v1/chat/completions` entrypoint.
async fn project_chat_completions(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let t_ingress = Instant::now();
    let catalog = state.catalog.load_full();
    if let Some(err_resp) = verify_project_auth(&catalog, &project_id, &headers) {
        return err_resp;
    }
    handle_routed_chat(state, catalog, &project_id, body, t_ingress).await
}

/// Sub-millisecond gateway processing timings (in milliseconds) captured prior to upstream transmission.
#[derive(Debug, Clone, Copy, Default)]
#[allow(clippy::struct_field_names)]
struct AttemptTimings {
    /// Total gateway overhead before upstream `send()` (`routing_ms + attempt_prep_ms`).
    gateway_overhead_ms: f64,
    /// Stages ①..③ routing & auth/parse duration in ms.
    routing_ms: f64,
    /// Stages ④..⑤ attempt preparation & payload serialization duration in ms.
    attempt_prep_ms: f64,
    /// Upstream HTTP response header establishment latency in ms.
    upstream_header_ms: f64,
}

/// RAII guard decrementing `outbound_inflight` when an upstream HTTP attempt exits.
struct OutboundInflightGuard<'a> {
    /// Shared runtime telemetry collector.
    runtime: &'a crate::runtime_metrics::RuntimeMetrics,
}

impl Drop for OutboundInflightGuard<'_> {
    fn drop(&mut self) {
        self.runtime
            .counters
            .outbound_inflight
            .fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Shared Stages ①..③ + upstream dispatch pipeline for `/model/{project_id}/v1/...`.
async fn handle_routed_chat(
    state: AppState,
    catalog: Arc<RuntimeCatalog>,
    project_id: &str,
    body: Value,
    t_ingress: Instant,
) -> Response {
    let Value::Object(body_map) = body else {
        return openai_error(
            StatusCode::BAD_REQUEST,
            "Request body must be a JSON object",
            "invalid_request_error",
        );
    };
    let Some(requested_model) = body_map
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
    else {
        return openai_error(
            StatusCode::BAD_REQUEST,
            "Missing required 'model' string field",
            "invalid_request_error",
        );
    };

    let parent_uid = Uuid::new_v4();
    match run_routing_stages(
        &catalog,
        &state.metrics,
        &state.engine,
        parent_uid,
        project_id,
        &requested_model,
        body_map,
    )
    .await
    {
        Ok(StageOutcome::Ready(plan)) => {
            let routing_ms = t_ingress.elapsed().as_secs_f64() * 1000.0;
            dispatch_plan(&state, &catalog, parent_uid, plan, routing_ms).await
        }
        Ok(StageOutcome::Rejected(reject)) => {
            let status =
                StatusCode::from_u16(reject.status_code).unwrap_or(StatusCode::BAD_REQUEST);
            openai_error(status, &reject.message, "script_rejected")
        }
        Err(err) => {
            warn!(error = %err, "routing script stage failed");
            openai_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("Routing script execution error: {err}"),
                "script_error",
            )
        }
    }
}

/// Outcome of trying a single upstream endpoint.
enum AttemptOutcome {
    /// Final HTTP response ready for downstream client.
    Respond(Response),
    /// Retryable failure before first byte, optionally preserving upstream error body.
    Retry(Option<(StatusCode, Vec<u8>, Option<String>)>),
}

/// Executes Stages ④ & ⑤ for each target in `plan.endpoints` with automatic pre-first-byte
/// fallback on transport error or configured HTTP fallback status codes.
async fn dispatch_plan(
    state: &AppState,
    catalog: &Arc<RuntimeCatalog>,
    parent_uid: Uuid,
    plan: RoutingPlan,
    routing_ms: f64,
) -> Response {
    let total = plan.endpoints.len();
    let mut last_error_response: Option<(StatusCode, Vec<u8>, Option<String>)> = None;

    for (idx, endpoint) in plan.endpoints.iter().enumerate() {
        let has_more = idx + 1 < total;
        match try_single_endpoint(
            state, catalog, parent_uid, &plan, idx, endpoint, has_more, routing_ms,
        )
        .await
        {
            AttemptOutcome::Respond(resp) => return resp,
            AttemptOutcome::Retry(err_payload) => {
                if err_payload.is_some() {
                    last_error_response = err_payload;
                }
            }
        }
    }

    if let Some((status, err_bytes, ct)) = last_error_response {
        let mut resp_headers = HeaderMap::new();
        let ct_val = ct
            .as_deref()
            .and_then(|s| HeaderValue::from_str(s).ok())
            .unwrap_or_else(|| HeaderValue::from_static("application/json"));
        resp_headers.insert(HeaderName::from_static("content-type"), ct_val);
        return (status, resp_headers, err_bytes).into_response();
    }

    openai_error(
        StatusCode::BAD_GATEWAY,
        "All upstream route candidates failed or were unavailable",
        "no_available_upstream",
    )
}

/// Attempts Stages ④ & ⑤ preparation and upstream HTTP execution for one endpoint.
#[allow(clippy::too_many_arguments)]
async fn try_single_endpoint(
    state: &AppState,
    catalog: &Arc<RuntimeCatalog>,
    parent_uid: Uuid,
    plan: &RoutingPlan,
    idx: usize,
    endpoint: &crate::models::RouteEndpoint,
    has_more: bool,
    routing_ms: f64,
) -> AttemptOutcome {
    let t_attempt = Instant::now();
    let attempt_num = u16::try_from(idx + 1).unwrap_or(u16::MAX);
    let Some((provider, model)) = catalog.find_model(&endpoint.provider_id, &endpoint.model_id)
    else {
        warn!(
            provider_id = %endpoint.provider_id,
            model_id = %endpoint.model_id,
            "route selected missing provider/model endpoint"
        );
        return AttemptOutcome::Retry(None);
    };

    let mut attempt_ctx = match prepare_attempt_context(
        catalog,
        &plan.snapshot_ctx,
        attempt_num,
        provider,
        model,
        &state.engine,
    )
    .await
    {
        Ok(StageOutcome::Ready(ctx)) => ctx,
        Ok(StageOutcome::Rejected(reject)) => {
            if has_more {
                warn!(
                    attempt = attempt_num,
                    provider = %provider.id,
                    model = %model.id,
                    message = %reject.message,
                    "stage ④/⑤ rejected candidate; trying fallback"
                );
                return AttemptOutcome::Retry(None);
            }
            let status =
                StatusCode::from_u16(reject.status_code).unwrap_or(StatusCode::BAD_REQUEST);
            return AttemptOutcome::Respond(openai_error(
                status,
                &reject.message,
                "script_rejected",
            ));
        }
        Err(err) => {
            warn!(attempt = attempt_num, provider = %provider.id, model = %model.id, error = %err, "stage ④/⑤ script failed");
            if has_more {
                return AttemptOutcome::Retry(None);
            }
            return AttemptOutcome::Respond(openai_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("Upstream attempt script error: {err}"),
                "script_error",
            ));
        }
    };

    let (outbound_headers, outbound_body) =
        prepare_outbound_payload(&mut attempt_ctx, &provider.api_key);
    let attempt_prep_ms = t_attempt.elapsed().as_secs_f64() * 1000.0;
    let timings = AttemptTimings {
        gateway_overhead_ms: routing_ms + attempt_prep_ms,
        routing_ms,
        attempt_prep_ms,
        upstream_header_ms: 0.0,
    };
    let attempt_uid = if idx == 0 { parent_uid } else { Uuid::new_v4() };

    send_upstream_attempt(
        state,
        catalog,
        plan,
        &attempt_ctx,
        &provider.id,
        &provider.name,
        &model.id,
        &model.name,
        attempt_uid,
        parent_uid,
        attempt_num,
        outbound_headers,
        outbound_body,
        has_more,
        timings,
    )
    .await
}

/// Sends one prepared HTTP request upstream and maps fallback statuses or streaming responses.
#[allow(clippy::too_many_arguments, clippy::too_many_lines)]
async fn send_upstream_attempt(
    state: &AppState,
    catalog: &Arc<RuntimeCatalog>,
    plan: &RoutingPlan,
    attempt_ctx: &ScriptContext,
    provider_id: &str,
    provider_name: &str,
    model_id: &str,
    model_name: &str,
    attempt_uid: Uuid,
    parent_uid: Uuid,
    attempt_num: u16,
    outbound_headers: BTreeMap<String, String>,
    outbound_body: Map<String, Value>,
    has_more: bool,
    mut timings: AttemptTimings,
) -> AttemptOutcome {
    let t_start = Instant::now();
    let started_at = Utc::now();
    state
        .runtime
        .record_gateway_timings(timings.routing_ms, timings.attempt_prep_ms);
    if attempt_num > 1 {
        state
            .runtime
            .counters
            .outbound_retry_count
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }
    state
        .runtime
        .counters
        .outbound_total
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    state
        .runtime
        .counters
        .outbound_inflight
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let _outbound_guard = OutboundInflightGuard {
        runtime: &state.runtime,
    };

    let mut req_builder = state.http_client.post(&attempt_ctx.request.url);
    for (k, v) in &outbound_headers {
        req_builder = req_builder.header(k, v);
    }
    if outbound_body.get("stream").and_then(Value::as_bool) != Some(true) {
        let timeout_secs = attempt_ctx
            .request
            .timeout_secs
            .unwrap_or(state.config.server.upstream_timeout_secs)
            .max(5);
        req_builder = req_builder.timeout(Duration::from_secs(timeout_secs));
    }
    let body_bytes = serde_json::to_vec(&outbound_body).unwrap_or_default();
    state.runtime.counters.outbound_req_bytes.fetch_add(
        u64::try_from(body_bytes.len()).unwrap_or(0),
        std::sync::atomic::Ordering::Relaxed,
    );

    let reasoning_effort = outbound_body
        .get("reasoning_effort")
        .and_then(Value::as_str)
        .map(str::to_string);
    let keep_error_payload =
        state.config.database.log_full_payload || state.config.database.log_error_payload;
    let saved_headers = keep_error_payload.then_some(outbound_headers);
    let saved_body = keep_error_payload.then_some(outbound_body);

    let upstream_res = match req_builder
        .header(CONTENT_TYPE, "application/json")
        .body(body_bytes)
        .send()
        .await
    {
        Ok(resp) => {
            timings.upstream_header_ms = t_start.elapsed().as_secs_f64() * 1000.0;
            resp
        }
        Err(err) => {
            let elapsed_ms = t_start.elapsed().as_secs_f64() * 1000.0;
            let conn_micros = u64::try_from(t_start.elapsed().as_micros()).unwrap_or(u64::MAX);
            state.runtime.record_outbound_conn_error(conn_micros);
            timings.upstream_header_ms = elapsed_ms;
            record_failed_attempt(
                state,
                catalog,
                attempt_ctx,
                plan,
                provider_name.to_string(),
                model_name.to_string(),
                attempt_uid,
                parent_uid,
                attempt_num,
                502,
                elapsed_ms,
                format!("upstream request error: {err}"),
                None,
                reasoning_effort,
                saved_headers.as_ref(),
                saved_body,
                started_at,
                timings,
            );
            if has_more {
                warn!(attempt = attempt_num, provider = %provider_id, model = %model_id, error = %err, "upstream connection failed; falling back");
                return AttemptOutcome::Retry(None);
            }
            return AttemptOutcome::Respond(openai_error(
                StatusCode::BAD_GATEWAY,
                &format!("Upstream request failed: {err}"),
                "upstream_connection_error",
            ));
        }
    };

    let status = upstream_res.status();
    let status_u16 = status.as_u16();
    let header_us = u64::try_from(t_start.elapsed().as_micros()).unwrap_or(u64::MAX);
    state.runtime.record_outbound_status(status_u16, header_us);
    let content_type = upstream_res
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    let fallback_codes = attempt_ctx
        .request
        .retry_status_codes
        .as_deref()
        .unwrap_or(&state.config.script_engine.fallback_status_codes);
    if fallback_codes.contains(&status_u16) {
        return handle_fallback_status(
            state,
            catalog,
            plan,
            attempt_ctx,
            provider_id,
            provider_name,
            model_id,
            model_name,
            attempt_uid,
            parent_uid,
            attempt_num,
            upstream_res,
            status,
            content_type,
            reasoning_effort,
            saved_headers.as_ref(),
            saved_body,
            t_start,
            started_at,
            has_more,
            timings,
        )
        .await;
    }

    let is_sse = status.is_success()
        && content_type
            .as_deref()
            .is_some_and(|ct| ct.to_ascii_lowercase().contains("text/event-stream"));

    let meta = build_inspection_metadata(
        state,
        catalog,
        attempt_ctx,
        plan,
        saved_headers.as_ref(),
        saved_body,
        reasoning_effort,
        provider_name.to_string(),
        model_name.to_string(),
        attempt_uid,
        parent_uid,
        attempt_num,
        i32::from(status_u16),
        is_sse,
        t_start,
        started_at,
        timings,
    );

    if is_sse {
        AttemptOutcome::Respond(stream_sse_response(state, upstream_res, status, meta))
    } else {
        AttemptOutcome::Respond(
            buffer_json_response(state, upstream_res, status, content_type.as_deref(), meta).await,
        )
    }
}

/// Logs a retryable HTTP status response and returns `AttemptOutcome::Retry`.
#[allow(clippy::too_many_arguments)]
async fn handle_fallback_status(
    state: &AppState,
    catalog: &Arc<RuntimeCatalog>,
    plan: &RoutingPlan,
    attempt_ctx: &ScriptContext,
    provider_id: &str,
    provider_name: &str,
    model_id: &str,
    model_name: &str,
    attempt_uid: Uuid,
    parent_uid: Uuid,
    attempt_num: u16,
    upstream_res: reqwest::Response,
    status: StatusCode,
    content_type: Option<String>,
    reasoning_effort: Option<String>,
    outbound_headers: Option<&BTreeMap<String, String>>,
    outbound_body: Option<Map<String, Value>>,
    t_start: Instant,
    started_at: chrono::DateTime<Utc>,
    has_more: bool,
    timings: AttemptTimings,
) -> AttemptOutcome {
    let status_u16 = status.as_u16();
    let err_bytes = upstream_res.bytes().await.unwrap_or_default();
    state.runtime.counters.outbound_resp_bytes.fetch_add(
        u64::try_from(err_bytes.len()).unwrap_or(0),
        std::sync::atomic::Ordering::Relaxed,
    );
    let err_text = String::from_utf8_lossy(&err_bytes).to_string();
    let elapsed_ms = t_start.elapsed().as_secs_f64() * 1000.0;
    let resp_json: Option<Value> = serde_json::from_slice(&err_bytes).ok();
    record_failed_attempt(
        state,
        catalog,
        attempt_ctx,
        plan,
        provider_name.to_string(),
        model_name.to_string(),
        attempt_uid,
        parent_uid,
        attempt_num,
        i32::from(status_u16),
        elapsed_ms,
        format!("HTTP {status_u16}: {err_text}"),
        resp_json,
        reasoning_effort,
        outbound_headers,
        outbound_body,
        started_at,
        timings,
    );
    if has_more {
        warn!(
            attempt = attempt_num,
            provider = %provider_id,
            model = %model_id,
            status = status_u16,
            "upstream returned fallback status; rolling back to Stage ③ snapshot"
        );
    }
    AttemptOutcome::Retry(Some((status, err_bytes.to_vec(), content_type)))
}

/// Builds final outbound headers (with provider bearer fallback) and body (`stream_options`)
/// by moving `body` and `headers` out of `attempt_ctx` without deep cloning.
fn prepare_outbound_payload(
    attempt_ctx: &mut ScriptContext,
    api_key: &str,
) -> (BTreeMap<String, String>, Map<String, Value>) {
    let mut outbound_body = std::mem::take(&mut attempt_ctx.request.body);
    if attempt_ctx.request.signals.is_stream
        && attempt_ctx.request.inject_stream_options
        && !outbound_body.contains_key("stream_options")
    {
        outbound_body.insert(
            "stream_options".to_string(),
            json!({ "include_usage": true }),
        );
    }
    let mut outbound_headers = std::mem::take(&mut attempt_ctx.request.headers);
    inject_provider_auth_if_absent(&mut outbound_headers, api_key);
    (outbound_headers, outbound_body)
}

/// Streams SSE bytes through `InspectedByteStream` with zero buffering delay.
fn stream_sse_response(
    state: &AppState,
    upstream_res: reqwest::Response,
    status: StatusCode,
    meta: InspectionMetadata,
) -> Response {
    let state_clone = state.clone();
    let on_complete: CompletionCallback = Arc::new(move |record| {
        if let Some(error) = &record.error_message {
            warn!(
                request_uid = %record.request_uid,
                provider = %record.provider_id,
                model = %record.model_id,
                attempt = record.attempt_index,
                error = %error,
                "SSE request interrupted"
            );
        } else {
            info!(
                request_uid = %record.request_uid,
                provider = %record.provider_id,
                model = %record.model_id,
                attempt = record.attempt_index,
                ttft_ms = record.ttft_ms,
                decode_tps = record.decode_tps,
                tokens = record.total_tokens,
                "completed SSE request"
            );
        }
        state_clone.emit_log(record);
    });

    let inspected_stream = InspectedByteStream::new(
        upstream_res.bytes_stream(),
        meta,
        state.metrics.clone(),
        on_complete,
    );

    let mut resp_headers = HeaderMap::new();
    resp_headers.insert(
        HeaderName::from_static("content-type"),
        HeaderValue::from_static("text/event-stream; charset=utf-8"),
    );
    resp_headers.insert(
        HeaderName::from_static("cache-control"),
        HeaderValue::from_static("no-cache"),
    );
    resp_headers.insert(
        HeaderName::from_static("x-accel-buffering"),
        HeaderValue::from_static("no"),
    );
    (status, resp_headers, Body::from_stream(inspected_stream)).into_response()
}

/// Handles non-streaming JSON or error response inspection and logging.
async fn buffer_json_response(
    state: &AppState,
    upstream_res: reqwest::Response,
    status: StatusCode,
    content_type: Option<&str>,
    meta: InspectionMetadata,
) -> Response {
    let body_bytes = match upstream_res.bytes().await {
        Ok(b) => {
            state.runtime.counters.outbound_resp_bytes.fetch_add(
                u64::try_from(b.len()).unwrap_or(0),
                std::sync::atomic::Ordering::Relaxed,
            );
            b
        }
        Err(err) => {
            let mut tracker = StreamTelemetryTracker::new(meta);
            if let Some((_, record)) =
                tracker.finalize(Some(format!("upstream response read failed: {err}")), None)
            {
                state.emit_log(record);
            }
            return openai_error(
                StatusCode::BAD_GATEWAY,
                &format!("Failed to read upstream body: {err}"),
                "upstream_read_error",
            );
        }
    };

    let mut tracker = StreamTelemetryTracker::new(meta);
    let rewritten = tracker.process_json_response(&body_bytes);
    let resp_json: Option<Value> = if status.is_success() {
        state
            .config
            .database
            .log_full_payload
            .then(|| serde_json::from_slice(&rewritten).ok())
            .flatten()
    } else {
        serde_json::from_slice(&body_bytes).ok()
    };
    let err_msg = (!status.is_success()).then(|| {
        format!(
            "HTTP {}: {}",
            status.as_u16(),
            String::from_utf8_lossy(&body_bytes)
        )
    });

    if let Some((metrics, record)) = tracker.finalize(err_msg, resp_json) {
        state.metrics.record(
            &record.provider_id,
            &record.model_id,
            MetricSample {
                timestamp: record.created_at,
                decode_tps: metrics.decode_tps,
                ttft_ms: metrics.ttft_ms,
                is_error: !status.is_success(),
            },
        );
        state.emit_log(record);
    }

    let mut resp_headers = HeaderMap::new();
    let ct_val = content_type
        .and_then(|s| HeaderValue::from_str(s).ok())
        .unwrap_or_else(|| HeaderValue::from_static("application/json"));
    resp_headers.insert(HeaderName::from_static("content-type"), ct_val);
    (status, resp_headers, rewritten).into_response()
}

/// Verifies the request's `Authorization: Bearer <token>` against the path project's `apiKey`.
///
/// Unknown projects, projects without a configured key, and wrong/missing tokens all produce the
/// same `401` response so project IDs cannot be enumerated.
fn verify_project_auth(
    catalog: &crate::catalog::RuntimeCatalog,
    project_id: &str,
    headers: &HeaderMap,
) -> Option<Response> {
    let authorized = extract_bearer_token(headers)
        .is_some_and(|token| catalog.verify_project_key(project_id, token));

    if authorized {
        None
    } else {
        Some(openai_error(
            StatusCode::UNAUTHORIZED,
            "Invalid or missing project Bearer API key",
            "authentication_error",
        ))
    }
}

/// Extracts Bearer token from `Authorization` header.
fn extract_bearer_token(headers: &HeaderMap) -> Option<&str> {
    let auth = headers.get("authorization")?.to_str().ok()?.trim();
    auth.strip_prefix("Bearer ")
        .or_else(|| auth.strip_prefix("bearer "))
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// Injects `authorization: Bearer <api_key>` unless Stage ⑤ already defined an authorization header.
fn inject_provider_auth_if_absent(headers: &mut BTreeMap<String, String>, api_key: &str) {
    if api_key.trim().is_empty() {
        return;
    }
    let has_auth = headers
        .keys()
        .any(|k| k.eq_ignore_ascii_case("authorization"));
    if !has_auth {
        headers.insert("authorization".to_string(), format!("Bearer {api_key}"));
    }
}

/// Redacts sensitive authorization headers before storing debug payload snapshots.
fn redact_headers_json(headers: &BTreeMap<String, String>) -> Value {
    let mut map = Map::new();
    for (k, v) in headers {
        if k.eq_ignore_ascii_case("authorization") || k.eq_ignore_ascii_case("x-api-key") {
            map.insert(k.clone(), Value::String("***REDACTED***".to_string()));
        } else {
            map.insert(k.clone(), Value::String(v.clone()));
        }
    }
    Value::Object(map)
}

/// Builds `InspectionMetadata` from a prepared Stage ⑤ `ScriptContext`.
#[allow(clippy::too_many_arguments)]
fn build_inspection_metadata(
    state: &AppState,
    catalog: &Arc<RuntimeCatalog>,
    ctx: &ScriptContext,
    plan: &RoutingPlan,
    headers: Option<&BTreeMap<String, String>>,
    body: Option<Map<String, Value>>,
    reasoning_effort: Option<String>,
    provider_name: String,
    model_name: String,
    request_uid: Uuid,
    parent_request_uid: Uuid,
    attempt_num: u16,
    status_code: i32,
    is_stream: bool,
    t_start: Instant,
    started_at: chrono::DateTime<Utc>,
    timings: AttemptTimings,
) -> InspectionMetadata {
    let keep_req_payload = state.config.database.log_full_payload
        || (state.config.database.log_error_payload && status_code >= 400);

    let provider_id = ctx
        .provider
        .as_ref()
        .map_or_else(String::new, |p| p.id.clone());
    let model_id = ctx
        .model
        .as_ref()
        .map_or_else(String::new, |m| m.id.clone());

    InspectionMetadata {
        request_uid,
        parent_request_uid,
        attempt_index: i16::try_from(attempt_num).unwrap_or(i16::MAX),
        project_id: ctx.project.id.clone(),
        project_name: plan.project_name.clone(),
        call_model_id: ctx.call_model.id.clone(),
        call_model_name: plan.call_model_name.clone(),
        provider_id,
        provider_name,
        model_id,
        model_name,
        route_rule_id: ctx.route.rule_id.clone().unwrap_or_default(),
        status_code,
        is_stream,
        rewrite_response_model: ctx.route.rewrite_response_model,
        estimated_input_chars: ctx.request.signals.estimated_input_chars,
        reasoning_effort,
        script_state: Value::Object(ctx.state.clone()),
        request_headers: keep_req_payload
            .then(|| headers.map(redact_headers_json))
            .flatten(),
        request_body: if keep_req_payload {
            body.map(Value::Object)
        } else {
            None
        },
        t_start,
        started_at,
        catalog_snapshot: Some(Arc::clone(catalog)),
        gateway_overhead_ms: timings.gateway_overhead_ms,
        routing_ms: timings.routing_ms,
        attempt_prep_ms: timings.attempt_prep_ms,
        upstream_header_ms: timings.upstream_header_ms,
        runtime_metrics: Some(Arc::clone(&state.runtime)),
    }
}

/// Records telemetry and updates `MetricsCache` for a failed/retried upstream attempt.
#[allow(clippy::too_many_arguments)]
fn record_failed_attempt(
    state: &AppState,
    catalog: &Arc<RuntimeCatalog>,
    ctx: &ScriptContext,
    plan: &RoutingPlan,
    provider_name: String,
    model_name: String,
    request_uid: Uuid,
    parent_request_uid: Uuid,
    attempt_num: u16,
    status_code: i32,
    elapsed_ms: f64,
    error_message: String,
    response_body: Option<Value>,
    reasoning_effort: Option<String>,
    outbound_headers: Option<&BTreeMap<String, String>>,
    outbound_body: Option<Map<String, Value>>,
    started_at: chrono::DateTime<Utc>,
    timings: AttemptTimings,
) {
    let provider_id = ctx
        .provider
        .as_ref()
        .map_or_else(String::new, |p| p.id.clone());
    let model_id = ctx
        .model
        .as_ref()
        .map_or_else(String::new, |m| m.id.clone());

    let now = Utc::now();
    state.metrics.record(
        &provider_id,
        &model_id,
        MetricSample {
            timestamp: now,
            decode_tps: 0.0,
            ttft_ms: elapsed_ms,
            is_error: true,
        },
    );

    let keep_payload =
        state.config.database.log_full_payload || state.config.database.log_error_payload;
    state.emit_log(RequestLogRecord {
        request_uid,
        parent_request_uid: Some(parent_request_uid),
        attempt_index: i16::try_from(attempt_num).unwrap_or(i16::MAX),
        created_at: now,
        started_at,
        interrupted: false,
        raw_usage: response_body.as_ref().and_then(|v| v.get("usage")).cloned(),
        catalog_snapshot: Some(Arc::clone(catalog)),
        project_id: ctx.project.id.clone(),
        project_name: plan.project_name.clone(),
        call_model_id: ctx.call_model.id.clone(),
        call_model_name: plan.call_model_name.clone(),
        provider_id,
        provider_name,
        model_id,
        model_name,
        route_rule_id: ctx.route.rule_id.clone().unwrap_or_default(),
        is_stream: ctx.request.signals.is_stream,
        status_code,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        reasoning_tokens: 0,
        extra_tokens: BTreeMap::new(),
        total_tokens: 0,
        ttft_ms: elapsed_ms,
        total_duration_ms: elapsed_ms,
        generation_duration_ms: 0.0,
        decode_tps: 0.0,
        e2e_tps: 0.0,
        gateway_overhead_ms: timings.gateway_overhead_ms,
        routing_ms: timings.routing_ms,
        attempt_prep_ms: timings.attempt_prep_ms,
        upstream_header_ms: timings.upstream_header_ms,
        finish_reason: None,
        reasoning_effort,
        token_source: "upstream_error".to_string(),
        script_state: Value::Object(ctx.state.clone()),
        error_message: keep_payload.then_some(error_message),
        request_headers: keep_payload
            .then(|| outbound_headers.map(redact_headers_json))
            .flatten(),
        request_body: if keep_payload {
            outbound_body.map(Value::Object)
        } else {
            None
        },
        response_body: keep_payload.then_some(response_body).flatten(),
    });
}

/// Formats a standard `OpenAI` JSON error response.
fn openai_error(status: StatusCode, message: &str, err_type: &str) -> Response {
    (
        status,
        Json(json!({
            "error": {
                "message": message,
                "type": err_type,
                "code": status.as_u16()
            }
        })),
    )
        .into_response()
}
