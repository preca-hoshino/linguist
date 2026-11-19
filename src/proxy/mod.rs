//! OpenAI-compatible HTTP gateway endpoints (`/g/{project}/v1/...`, `/v1/...`,
//! `/p/{provider}/v1/...`), authentication, fallback execution, and zero-hook streaming.

pub mod stream_inspector;

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Instant;

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

use crate::metrics_cache::MetricSample;
use crate::models::{RequestLogRecord, ScriptContext};
use crate::proxy::stream_inspector::{
    CompletionCallback, InspectedByteStream, InspectionMetadata, StreamTelemetryTracker,
};
use crate::script_engine::pipeline::{
    RoutingPlan, StageOutcome, build_direct_provider_plan, prepare_attempt_context,
    run_routing_stages,
};
use crate::state::AppState;

/// Registers OpenAI-compatible proxy endpoints and `/healthz` on the Axum router.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/healthz", get(healthz_handler))
        .route("/v1/chat/completions", post(unified_chat_completions))
        .route("/v1/models", get(unified_list_models))
        .route(
            "/g/{project_id}/v1/chat/completions",
            post(project_chat_completions),
        )
        .route("/g/{project_id}/v1/models", get(project_list_models))
        .route(
            "/p/{provider_id}/v1/chat/completions",
            post(direct_provider_chat_completions),
        )
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

/// Unified `/v1/models` handler.
async fn unified_list_models(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let catalog = state.catalog.load();
    let project_id = resolve_project_id_from_headers(&catalog, &headers);
    if let Some(err_resp) = verify_project_auth(&catalog, &project_id, &headers) {
        return err_resp;
    }
    let models = catalog.list_openai_models(Some(&project_id));
    Json(json!({ "object": "list", "data": models })).into_response()
}

/// Project-scoped `/g/{project_id}/v1/models` handler.
async fn project_list_models(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let catalog = state.catalog.load();
    if catalog.find_project(&project_id).is_none() {
        return openai_error(
            StatusCode::NOT_FOUND,
            &format!("Project '{project_id}' not found"),
            "not_found_error",
        );
    }
    if let Some(err_resp) = verify_project_auth(&catalog, &project_id, &headers) {
        return err_resp;
    }
    let models = catalog.list_openai_models(Some(&project_id));
    Json(json!({ "object": "list", "data": models })).into_response()
}

/// Unified `/v1/chat/completions` entrypoint resolving project via header, bearer key, or `"default"`.
async fn unified_chat_completions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let catalog = state.catalog.load();
    let project_id = resolve_project_id_from_headers(&catalog, &headers);
    if let Some(err_resp) = verify_project_auth(&catalog, &project_id, &headers) {
        return err_resp;
    }
    handle_routed_chat(state, &catalog, &project_id, body).await
}

/// Project-scoped `/g/{project_id}/v1/chat/completions` entrypoint.
async fn project_chat_completions(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let catalog = state.catalog.load();
    if catalog.find_project(&project_id).is_none() {
        return openai_error(
            StatusCode::NOT_FOUND,
            &format!("Project '{project_id}' not found"),
            "not_found_error",
        );
    }
    if let Some(err_resp) = verify_project_auth(&catalog, &project_id, &headers) {
        return err_resp;
    }
    handle_routed_chat(state, &catalog, &project_id, body).await
}

/// Direct provider debug entrypoint `/p/{provider_id}/v1/chat/completions`, skipping Stages ①..③
/// while executing Stages ④ and ⑤ and full telemetry inspection.
async fn direct_provider_chat_completions(
    State(state): State<AppState>,
    Path(provider_id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let Some(body_map) = body.as_object().cloned() else {
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
    else {
        return openai_error(
            StatusCode::BAD_REQUEST,
            "Missing required 'model' string field",
            "invalid_request_error",
        );
    };

    let catalog = state.catalog.load();
    let Some((provider, model)) = catalog.find_model(&provider_id, requested_model) else {
        return openai_error(
            StatusCode::NOT_FOUND,
            &format!("Model '{provider_id}/{requested_model}' not found"),
            "not_found_error",
        );
    };

    let parent_uid = Uuid::new_v4();
    let plan = build_direct_provider_plan(provider, model, parent_uid, body_map);
    dispatch_plan(&state, &catalog, parent_uid, plan).await
}

/// Shared Stages ①..③ + upstream dispatch pipeline for `/g/{project}` and `/v1`.
async fn handle_routed_chat(
    state: AppState,
    catalog: &crate::catalog::RuntimeCatalog,
    project_id: &str,
    body: Value,
) -> Response {
    let Some(body_map) = body.as_object().cloned() else {
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
        catalog,
        &state.metrics,
        &state.engine,
        parent_uid,
        project_id,
        &requested_model,
        body_map,
    )
    .await
    {
        Ok(StageOutcome::Ready(plan)) => dispatch_plan(&state, catalog, parent_uid, plan).await,
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
    catalog: &crate::catalog::RuntimeCatalog,
    parent_uid: Uuid,
    plan: RoutingPlan,
) -> Response {
    let total = plan.endpoints.len();
    let mut last_error_response: Option<(StatusCode, Vec<u8>, Option<String>)> = None;

    for (idx, endpoint) in plan.endpoints.iter().enumerate() {
        let has_more = idx + 1 < total;
        match try_single_endpoint(state, catalog, parent_uid, &plan, idx, endpoint, has_more).await
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
async fn try_single_endpoint(
    state: &AppState,
    catalog: &crate::catalog::RuntimeCatalog,
    parent_uid: Uuid,
    plan: &RoutingPlan,
    idx: usize,
    endpoint: &crate::models::RouteEndpoint,
    has_more: bool,
) -> AttemptOutcome {
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

    let attempt_ctx = match prepare_attempt_context(
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
        prepare_outbound_payload(&attempt_ctx, &provider.api_key);
    let attempt_uid = if idx == 0 { parent_uid } else { Uuid::new_v4() };

    send_upstream_attempt(
        state,
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
    )
    .await
}

/// Sends one prepared HTTP request upstream and maps fallback statuses or streaming responses.
#[allow(clippy::too_many_arguments)]
async fn send_upstream_attempt(
    state: &AppState,
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
) -> AttemptOutcome {
    let t_start = Instant::now();
    let mut req_builder = state.http_client.post(&attempt_ctx.request.url);
    for (k, v) in &outbound_headers {
        req_builder = req_builder.header(k, v);
    }

    let upstream_res = match req_builder.json(&outbound_body).send().await {
        Ok(resp) => resp,
        Err(err) => {
            let elapsed_ms = t_start.elapsed().as_secs_f64() * 1000.0;
            record_failed_attempt(
                state,
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
    let content_type = upstream_res
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    if state
        .config
        .script_engine
        .fallback_status_codes
        .contains(&status_u16)
    {
        return handle_fallback_status(
            state,
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
            t_start,
            has_more,
        )
        .await;
    }

    let is_sse = status.is_success()
        && content_type
            .as_deref()
            .is_some_and(|ct| ct.to_ascii_lowercase().contains("text/event-stream"));

    let meta = build_inspection_metadata(
        state,
        attempt_ctx,
        plan,
        &outbound_headers,
        &outbound_body,
        provider_name.to_string(),
        model_name.to_string(),
        attempt_uid,
        parent_uid,
        attempt_num,
        i32::from(status_u16),
        is_sse,
        t_start,
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
    t_start: Instant,
    has_more: bool,
) -> AttemptOutcome {
    let status_u16 = status.as_u16();
    let err_bytes = upstream_res.bytes().await.unwrap_or_default();
    let err_text = String::from_utf8_lossy(&err_bytes).to_string();
    let elapsed_ms = t_start.elapsed().as_secs_f64() * 1000.0;
    let resp_json: Option<Value> = serde_json::from_slice(&err_bytes).ok();
    record_failed_attempt(
        state,
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

/// Builds final outbound headers (with provider bearer fallback) and body (`stream_options`).
fn prepare_outbound_payload(
    attempt_ctx: &ScriptContext,
    api_key: &str,
) -> (BTreeMap<String, String>, Map<String, Value>) {
    let mut outbound_body = attempt_ctx.request.body.clone();
    if attempt_ctx.request.signals.is_stream && !outbound_body.contains_key("stream_options") {
        outbound_body.insert(
            "stream_options".to_string(),
            json!({ "include_usage": true }),
        );
    }
    let mut outbound_headers = attempt_ctx.request.headers.clone();
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
        Ok(b) => b,
        Err(err) => {
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

/// Resolves project ID on `/v1/...` routes via `X-Linguist-Project` (or `X-TokPulse-Project`),
/// then matching `projects[].apiKey` Bearer token, then `"default"`.
fn resolve_project_id_from_headers(
    catalog: &crate::catalog::RuntimeCatalog,
    headers: &HeaderMap,
) -> String {
    if let Some(explicit) = headers
        .get("x-linguist-project")
        .or_else(|| headers.get("x-tokpulse-project"))
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return explicit.to_string();
    }

    if let Some(token) = extract_bearer_token(headers)
        && let Some(project) = catalog.find_project_by_api_key(token)
    {
        return project.id.clone();
    }

    "default".to_string()
}

/// Verifies `projects[].apiKey` against the request's `Authorization: Bearer <token>`
/// header when the project defines an API key, returning `Some(Response)` on failure.
fn verify_project_auth(
    catalog: &crate::catalog::RuntimeCatalog,
    project_id: &str,
    headers: &HeaderMap,
) -> Option<Response> {
    let Some(project) = catalog.find_project(project_id) else {
        return Some(openai_error(
            StatusCode::NOT_FOUND,
            &format!("Project '{project_id}' not found"),
            "not_found_error",
        ));
    };

    let expected_key = project.api_key.as_deref()?;

    match extract_bearer_token(headers) {
        Some(provided) if provided == expected_key => None,
        _ => Some(openai_error(
            StatusCode::UNAUTHORIZED,
            "Invalid or missing project Bearer API key",
            "authentication_error",
        )),
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
    ctx: &ScriptContext,
    plan: &RoutingPlan,
    headers: &BTreeMap<String, String>,
    body: &Map<String, Value>,
    provider_name: String,
    model_name: String,
    request_uid: Uuid,
    parent_request_uid: Uuid,
    attempt_num: u16,
    status_code: i32,
    is_stream: bool,
    t_start: Instant,
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
        route_rule_id: ctx.route.rule_id.clone(),
        status_code,
        is_stream,
        rewrite_response_model: ctx.route.rewrite_response_model,
        estimated_input_chars: ctx.request.signals.estimated_input_chars,
        reasoning_effort: body
            .get("reasoning_effort")
            .and_then(Value::as_str)
            .map(str::to_string),
        script_state: Value::Object(ctx.state.clone()),
        request_headers: keep_req_payload.then(|| redact_headers_json(headers)),
        request_body: keep_req_payload.then(|| Value::Object(body.clone())),
        t_start,
    }
}

/// Records telemetry and updates `MetricsCache` for a failed/retried upstream attempt.
#[allow(clippy::too_many_arguments)]
fn record_failed_attempt(
    state: &AppState,
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
        project_id: ctx.project.id.clone(),
        project_name: plan.project_name.clone(),
        call_model_id: ctx.call_model.id.clone(),
        call_model_name: plan.call_model_name.clone(),
        provider_id,
        provider_name,
        model_id,
        model_name,
        route_rule_id: ctx.route.rule_id.clone(),
        is_stream: ctx.request.signals.is_stream,
        status_code,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        reasoning_tokens: 0,
        total_tokens: 0,
        ttft_ms: elapsed_ms,
        total_duration_ms: elapsed_ms,
        generation_duration_ms: 0.0,
        decode_tps: 0.0,
        e2e_tps: 0.0,
        finish_reason: None,
        reasoning_effort: ctx
            .request
            .body
            .get("reasoning_effort")
            .and_then(Value::as_str)
            .map(str::to_string),
        token_source: "upstream_error".to_string(),
        script_state: Value::Object(ctx.state.clone()),
        error_message: keep_payload.then_some(error_message),
        request_headers: keep_payload.then(|| redact_headers_json(&ctx.request.headers)),
        request_body: keep_payload.then(|| Value::Object(ctx.request.body.clone())),
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
