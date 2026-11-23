//! L2 HTTP end-to-end integration tests for the Linguist `OpenAI` gateway.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use arc_swap::ArcSwap;
use axum::Json;
use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use futures::StreamExt;
use serde_json::{Map, Value, json};
use tokio::net::TcpListener;

use linguist::catalog::RuntimeCatalog;
use linguist::config::{AppConfig, MetricsConfig, ScriptEngineConfig};
use linguist::metrics_cache::MetricsCache;
use linguist::models::{
    CallModelConfig, ModelConfig, ProjectConfig, ProviderConfig, RouteCandidatesFilter,
    RouteEndpoint, RouteMatchConfig, RouteRuleConfig,
};
use linguist::script_engine::ScriptEngine;
use linguist::state::AppState;
use linguist::web;

/// Captured upstream HTTP request inspected by tests.
#[derive(Debug, Clone)]
struct RecordedUpstreamCall {
    /// Lowercase header map sent to mock upstream.
    headers: BTreeMap<String, String>,
    /// JSON body sent to mock upstream.
    body: Value,
}

/// Shared mock upstream server state.
#[derive(Debug, Clone, Default)]
struct MockUpstreamState {
    /// Captured calls hitting `/primary/...`.
    primary_calls: Arc<Mutex<Vec<RecordedUpstreamCall>>>,
    /// Captured calls hitting `/fallback/...`.
    fallback_calls: Arc<Mutex<Vec<RecordedUpstreamCall>>>,
    /// Configured primary responses, defaulting to HTTP 429 when exhausted.
    primary_statuses: Arc<Mutex<VecDeque<StatusCode>>>,
}

/// Captures request headers and JSON body into a `RecordedUpstreamCall`.
fn capture_call(headers: &HeaderMap, body: Value) -> RecordedUpstreamCall {
    let mut map = BTreeMap::new();
    for (k, v) in headers {
        if let Ok(val) = v.to_str() {
            map.insert(k.as_str().to_ascii_lowercase(), val.to_string());
        }
    }
    RecordedUpstreamCall { headers: map, body }
}

/// Mock primary upstream endpoint returning configured statuses or HTTP 429.
async fn mock_primary(
    State(state): State<MockUpstreamState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    state
        .primary_calls
        .lock()
        .unwrap()
        .push(capture_call(&headers, body.clone()));
    let status = state
        .primary_statuses
        .lock()
        .unwrap()
        .pop_front()
        .unwrap_or(StatusCode::TOO_MANY_REQUESTS);
    if status.is_success() {
        mock_chat_response(&body)
    } else {
        (
            status,
            Json(json!({ "error": { "message": "mock failure" } })),
        )
            .into_response()
    }
}

/// Mock fallback upstream endpoint supporting both streaming SSE and JSON chat responses.
async fn mock_fallback_ok(
    State(state): State<MockUpstreamState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    state
        .fallback_calls
        .lock()
        .unwrap()
        .push(capture_call(&headers, body.clone()));
    mock_chat_response(&body)
}

/// Builds a mock streaming or JSON completion.
fn mock_chat_response(body: &Value) -> Response {
    let is_stream = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();

    if is_stream {
        let chunks = vec![
            Ok::<_, std::io::Error>(bytes::Bytes::from(format!(
                "data: {{\"id\":\"chatcmpl-1\",\"model\":\"{model}\",\"choices\":[{{\"index\":0,\"delta\":{{\"content\":\"Hello \"}}}}]}}\n\n"
            ))),
            Ok(bytes::Bytes::from(format!(
                "data: {{\"id\":\"chatcmpl-1\",\"model\":\"{model}\",\"choices\":[{{\"index\":0,\"delta\":{{\"content\":\"Linguist!\"}},\"finish_reason\":\"stop\"}}],\"usage\":{{\"prompt_tokens\":12,\"completion_tokens\":2,\"total_tokens\":14}}}}\n\n"
            ))),
            Ok(bytes::Bytes::from("data: [DONE]\n\n")),
        ];
        let stream = futures::stream::iter(chunks);
        let mut resp_headers = HeaderMap::new();
        resp_headers.insert(
            axum::http::header::CONTENT_TYPE,
            axum::http::HeaderValue::from_static("text/event-stream"),
        );
        (StatusCode::OK, resp_headers, Body::from_stream(stream)).into_response()
    } else {
        (
            StatusCode::OK,
            Json(json!({
                "id": "chatcmpl-json",
                "object": "chat.completion",
                "model": model,
                "choices": [{
                    "index": 0,
                    "message": { "role": "assistant", "content": "ok" },
                    "finish_reason": "stop"
                }],
                "usage": { "prompt_tokens": 10, "completion_tokens": 1, "total_tokens": 11 }
            })),
        )
            .into_response()
    }
}

/// Spawns an in-process mock upstream `OpenAI` server and returns `(base_url, state)`.
async fn spawn_mock_upstream() -> (String, MockUpstreamState) {
    let state = MockUpstreamState::default();
    let app = Router::new()
        .route("/primary/v1/chat/completions", post(mock_primary))
        .route("/fallback/v1/chat/completions", post(mock_fallback_ok))
        .with_state(state.clone());

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{addr}"), state)
}

/// Builds mock supply-side providers wired to `mock_base_url`.
fn e2e_providers(mock_base_url: &str) -> Vec<ProviderConfig> {
    vec![
        ProviderConfig {
            vendor: None,
            api_type: None,
            id: "primary-prov".to_string(),
            name: "Primary".to_string(),
            icon: "openai".to_string(),
            api_key: "sk-primary".to_string(),
            script: Some("ctx.request.headers['x-prov-tag'] = 'primary';".to_string()),
            models: vec![ModelConfig {
                id: "m-primary".to_string(),
                name: "Primary Model".to_string(),
                icon: "openai".to_string(),
                url: format!("{mock_base_url}/primary"),
                supports_reasoning_effort: Some(vec!["xhigh".to_string()]),
                tool_calling: Some(true),
                vision: Some(true),
                thinking: Some(true),
                streaming: Some(true),
                max_input_tokens: Some(128_000),
                max_output_tokens: Some(16_000),
                script: Some("ctx.request.body.reasoning_effort = 'xhigh';".to_string()),
            }],
        },
        ProviderConfig {
            vendor: None,
            api_type: None,
            id: "fallback-prov".to_string(),
            name: "Fallback".to_string(),
            icon: "qwen-color".to_string(),
            api_key: "sk-fallback".to_string(),
            script: Some("ctx.request.headers['x-prov-tag'] = 'fallback-clean';".to_string()),
            models: vec![ModelConfig {
                id: "m-fallback".to_string(),
                name: "Fallback Model".to_string(),
                icon: "qwen-color".to_string(),
                url: format!("{mock_base_url}/fallback"),
                supports_reasoning_effort: Some(vec!["high".to_string()]),
                tool_calling: Some(true),
                vision: Some(true),
                thinking: Some(true),
                streaming: Some(true),
                max_input_tokens: Some(128_000),
                max_output_tokens: Some(16_000),
                script: None,
            }],
        },
    ]
}

/// Builds test projects for E2E verification.
fn e2e_projects() -> Vec<ProjectConfig> {
    let mut cm_meta = Map::new();
    cm_meta.insert("defaultEffort".to_string(), json!("high"));

    vec![
        ProjectConfig {
            id: "default".to_string(),
            name: "Default".to_string(),
            api_key: Some("lin-proj-default-secret".to_string()),
            icon: "copilot-color".to_string(),
            meta: Map::new(),
            script: None,
            call_models: vec![CallModelConfig {
                id: "m-fallback".to_string(),
                name: "Fallback Passthrough".to_string(),
                icon: "codex-color".to_string(),
                meta: Map::new(),
                script: None,
            }],
        },
        ProjectConfig {
            id: "coding".to_string(),
            name: "VS Code Coding".to_string(),
            api_key: Some("lin-proj-coding-secret".to_string()),
            icon: "githubcopilot".to_string(),
            meta: Map::new(),
            script: None,
            call_models: vec![CallModelConfig {
                id: "smart-coder".to_string(),
                name: "Smart Coder".to_string(),
                icon: "cursor".to_string(),
                meta: cm_meta,
                script: Some(
                    "ctx.request.body.reasoning_effort ??= ctx.callModel.meta.defaultEffort;"
                        .to_string(),
                ),
            }],
        },
    ]
}

/// Builds test routing rules for E2E verification.
fn e2e_routes() -> Vec<RouteRuleConfig> {
    vec![
        RouteRuleConfig {
            id: "coding-smart".to_string(),
            name: "Coding Smart".to_string(),
            enabled: true,
            priority: 100,
            match_rule: RouteMatchConfig {
                project_ids: vec!["coding".to_string()],
                call_model_ids: vec!["smart-coder".to_string()],
            },
            candidates: RouteCandidatesFilter::default(),
            target: Some(RouteEndpoint {
                provider_id: "primary-prov".to_string(),
                model_id: "m-primary".to_string(),
                max_attempts: 1,
            }),
            fallbacks: vec![RouteEndpoint {
                provider_id: "fallback-prov".to_string(),
                model_id: "m-fallback".to_string(),
                max_attempts: 1,
            }],
            rewrite_response_model: true,
            script: None,
        },
        RouteRuleConfig {
            id: "default-pass".to_string(),
            name: "Default Pass".to_string(),
            enabled: true,
            priority: 0,
            match_rule: RouteMatchConfig {
                project_ids: vec!["*".to_string()],
                call_model_ids: vec!["*".to_string()],
            },
            candidates: RouteCandidatesFilter::default(),
            target: None,
            fallbacks: Vec::new(),
            rewrite_response_model: false,
            script: Some(
                "const match = ctx.route.candidates.find(c => c.model.id === ctx.callModel.id); \
                 if (!match) { ctx.reject = { statusCode: 404, message: 'Not found' }; return; } \
                 ctx.route.target = { providerId: match.provider.id, modelId: match.model.id };"
                    .to_string(),
            ),
        },
    ]
}

/// Builds the test `RuntimeCatalog` wired to `mock_base_url`.
fn build_e2e_catalog(mock_base_url: &str) -> RuntimeCatalog {
    RuntimeCatalog::new(e2e_providers(mock_base_url), e2e_projects(), e2e_routes())
}

/// Spawns an in-process Linguist gateway wired to the mock upstream and returns `base_url`.
async fn spawn_gateway(mock_base_url: &str) -> String {
    spawn_gateway_with_catalog(build_e2e_catalog(mock_base_url)).await
}

/// Spawns a gateway using a caller-supplied catalog.
async fn spawn_gateway_with_catalog(catalog: RuntimeCatalog) -> String {
    spawn_gateway_with_config(catalog, AppConfig::default()).await
}

/// Spawns a gateway with a caller-supplied catalog and configuration.
async fn spawn_gateway_with_config(catalog: RuntimeCatalog, cfg: AppConfig) -> String {
    let catalog = Arc::new(ArcSwap::from_pointee(catalog));
    let metrics = MetricsCache::new(&MetricsConfig::default());
    let engine = ScriptEngine::new(ScriptEngineConfig::default());
    let state = AppState::new(cfg, catalog, metrics, engine, None, None).unwrap();
    let app = web::build_router(state);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{addr}")
}

/// Sends either an active or a stalled SSE response, or a slowly delivered JSON response.
async fn mock_slow_response(Json(body): Json<Value>) -> Response {
    let scenario = body["test_scenario"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    if scenario == "headers" {
        tokio::time::sleep(Duration::from_secs(6)).await;
    }
    let content_type = if scenario == "json" {
        "application/json"
    } else {
        "text/event-stream"
    };
    let stream = futures::stream::unfold((0_u8, scenario), |(index, scenario)| async move {
        if index > 6 {
            return None;
        }
        if index > 0 {
            let delay = if scenario == "stalled" { 6 } else { 1 };
            tokio::time::sleep(Duration::from_secs(delay)).await;
        }
        let chunk = if scenario == "json" {
            if index == 0 {
                "{\"content\":\""
            } else if index == 6 {
                "\"}"
            } else {
                "x"
            }
        } else if index == 6 || (scenario == "stalled" && index == 1) {
            "data: [DONE]\n\n"
        } else {
            "data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n\n"
        };
        Some((
            Ok::<_, std::io::Error>(bytes::Bytes::from_static(chunk.as_bytes())),
            (index + 1, scenario),
        ))
    });
    (
        StatusCode::OK,
        [(axum::http::header::CONTENT_TYPE, content_type)],
        Body::from_stream(stream),
    )
        .into_response()
}

#[tokio::test]
async fn streaming_timeout_tracks_inactivity_not_total_duration() {
    let app = Router::new().route("/primary/v1/chat/completions", post(mock_slow_response));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mock_url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let mut config = AppConfig::default();
    config.server.upstream_timeout_secs = 5;
    let mut routes = e2e_routes();
    routes[0].fallbacks.clear();
    let catalog = RuntimeCatalog::new(e2e_providers(&mock_url), e2e_projects(), routes);
    let gateway = spawn_gateway_with_config(catalog, config).await;
    let url = format!("{gateway}/model/coding/v1/chat/completions");
    let client = reqwest::Client::new();

    let run = |scenario: &'static str, stream: bool| {
        let client = &client;
        let url = &url;
        async move {
            let response = client
                .post(url)
                .bearer_auth("lin-proj-coding-secret")
                .json(&json!({
                    "model": "smart-coder",
                    "stream": stream,
                    "messages": [{"role": "user", "content": "hi"}],
                    "test_scenario": scenario
                }))
                .send()
                .await
                .unwrap();
            let status = response.status();
            (status, response.bytes().await)
        }
    };

    let (active, stalled, json, headers) = tokio::join!(
        run("active", true),
        run("stalled", true),
        run("json", false),
        run("headers", true),
    );
    assert_eq!(active.0, StatusCode::OK);
    let active = active
        .1
        .expect("active SSE must remain open beyond the total timeout");
    let active = String::from_utf8_lossy(&active);
    assert_eq!(active.matches("\"content\":\"x\"").count(), 6);
    assert!(active.contains("data: [DONE]"));
    assert_eq!(stalled.0, StatusCode::OK);
    assert!(stalled.1.is_err(), "stalled SSE must time out");
    // The gateway returns a 502 JSON response when a non-streaming body exceeds the deadline.
    assert_eq!(json.0, StatusCode::BAD_GATEWAY);
    let json = json
        .1
        .expect("gateway should return a non-streaming timeout error response");
    assert!(String::from_utf8_lossy(&json).contains("upstream_read_error"));
    assert_eq!(headers.0, StatusCode::BAD_GATEWAY);
    let headers = headers
        .1
        .expect("gateway should return a header timeout error response");
    assert!(String::from_utf8_lossy(&headers).contains("upstream_connection_error"));
}

#[tokio::test]
async fn endpoint_retries_are_bounded_and_start_over_for_each_request() {
    let (mock_url, mock_state) = spawn_mock_upstream().await;
    mock_state.primary_statuses.lock().unwrap().extend([
        StatusCode::TOO_MANY_REQUESTS,
        StatusCode::TOO_MANY_REQUESTS,
        StatusCode::TOO_MANY_REQUESTS,
        StatusCode::OK,
        StatusCode::BAD_REQUEST,
    ]);
    let mut routes = e2e_routes();
    routes[0].script = Some(
        "ctx.route.target = { providerId: 'primary-prov', modelId: 'm-primary', maxAttempts: 2 }; \
         ctx.route.fallbacks = [ \
           { providerId: 'primary-prov', modelId: 'm-primary', maxAttempts: 5 }, \
           { providerId: 'fallback-prov', modelId: 'm-fallback' } \
         ];"
        .to_string(),
    );
    let mut providers = e2e_providers(&mock_url);
    for provider in &mut providers {
        provider.script =
            Some("ctx.request.headers['x-attempt'] = String(ctx.request.attempt);".to_string());
    }
    let catalog = RuntimeCatalog::new(providers, e2e_projects(), routes);
    let gw_url = spawn_gateway_with_catalog(catalog).await;
    let client = reqwest::Client::new();
    let coding = format!("{gw_url}/model/coding/v1/chat/completions");

    let first = post_chat(
        &client,
        coding.clone(),
        Some("lin-proj-coding-secret"),
        "smart-coder",
        false,
    )
    .await;
    assert_eq!(first.status(), StatusCode::OK);
    {
        let primaries = mock_state.primary_calls.lock().unwrap();
        let fallbacks = mock_state.fallback_calls.lock().unwrap();
        assert_eq!(primaries.len(), 2);
        assert_eq!(primaries[0].headers["x-attempt"], "1");
        assert_eq!(primaries[1].headers["x-attempt"], "2");
        assert_eq!(fallbacks.len(), 1);
        assert_eq!(fallbacks[0].headers["x-attempt"], "3");
        assert_eq!(fallbacks[0].body["reasoning_effort"], json!("high"));
    }

    let second = post_chat(
        &client,
        coding.clone(),
        Some("lin-proj-coding-secret"),
        "smart-coder",
        false,
    )
    .await;
    assert_eq!(second.status(), StatusCode::OK);
    assert_eq!(mock_state.primary_calls.lock().unwrap().len(), 4);
    assert_eq!(mock_state.fallback_calls.lock().unwrap().len(), 1);

    let third = post_chat(
        &client,
        coding,
        Some("lin-proj-coding-secret"),
        "smart-coder",
        false,
    )
    .await;
    assert_eq!(third.status(), StatusCode::BAD_REQUEST);
    assert_eq!(mock_state.primary_calls.lock().unwrap().len(), 5);
    assert_eq!(mock_state.fallback_calls.lock().unwrap().len(), 1);
}

/// Sends a chat request to `path` with an optional Bearer key and returns the HTTP response.
async fn post_chat(
    client: &reqwest::Client,
    url: String,
    key: Option<&str>,
    model: &str,
    stream: bool,
) -> reqwest::Response {
    let mut req = client.post(url).json(&json!({
        "model": model,
        "stream": stream,
        "messages": [{"role": "user", "content": "hi"}]
    }));
    if let Some(key) = key {
        req = req.bearer_auth(key);
    }
    req.send().await.unwrap()
}

#[tokio::test]
#[allow(clippy::too_many_lines)]
async fn gateway_e2e_project_scoped_auth_fallback_snapshot_and_rewrite() {
    let (mock_url, mock_state) = spawn_mock_upstream().await;
    let gw_url = spawn_gateway(&mock_url).await;
    let client = reqwest::Client::new();
    let coding = format!("{gw_url}/model/coding/v1/chat/completions");

    // 1. Auth enforcement on `/model/{project_id}/v1/chat/completions`.
    let unauth = post_chat(&client, coding.clone(), None, "smart-coder", false).await;
    assert_eq!(unauth.status(), StatusCode::UNAUTHORIZED);

    let wrong = post_chat(&client, coding.clone(), Some("nope"), "smart-coder", false).await;
    assert_eq!(wrong.status(), StatusCode::UNAUTHORIZED);

    // A key from another project must not unlock this project's path.
    let cross = post_chat(
        &client,
        coding.clone(),
        Some("lin-proj-default-secret"),
        "smart-coder",
        false,
    )
    .await;
    assert_eq!(cross.status(), StatusCode::UNAUTHORIZED);

    // Unknown projects look exactly like bad keys (no project enumeration).
    let unknown = post_chat(
        &client,
        format!("{gw_url}/model/nonexistent/v1/chat/completions"),
        Some("lin-proj-coding-secret"),
        "smart-coder",
        false,
    )
    .await;
    assert_eq!(unknown.status(), StatusCode::UNAUTHORIZED);

    // 2. Streaming request:
    //    - Primary gets 429 (with reasoning_effort='xhigh' from Stage ④)
    //    - Fallback rolls back to Stage ③ snapshot (`reasoning_effort='high'`), receives Stage ⑤ header
    //    - Response SSE `model` is rewritten back to `smart-coder`.
    let sse_resp = post_chat(
        &client,
        coding.clone(),
        Some("lin-proj-coding-secret"),
        "smart-coder",
        true,
    )
    .await;
    assert_eq!(sse_resp.status(), StatusCode::OK);
    assert_eq!(sse_resp.headers()["x-accel-buffering"], "no");

    let mut stream = sse_resp.bytes_stream();
    let mut full_sse = String::new();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.unwrap();
        full_sse.push_str(&String::from_utf8_lossy(&bytes));
    }
    assert!(full_sse.contains("\"model\":\"smart-coder\""));
    assert!(!full_sse.contains("\"model\":\"m-fallback\""));
    assert!(full_sse.contains("Linguist!"));

    {
        let primaries = mock_state.primary_calls.lock().unwrap();
        assert_eq!(primaries.len(), 1);
        assert_eq!(primaries[0].body["reasoning_effort"], json!("xhigh"));

        let fallbacks = mock_state.fallback_calls.lock().unwrap();
        assert_eq!(fallbacks.len(), 1);
        assert_eq!(fallbacks[0].body["reasoning_effort"], json!("high"));
        assert_eq!(fallbacks[0].body["model"], json!("m-fallback"));
        assert_eq!(
            fallbacks[0].headers.get("x-prov-tag").map(String::as_str),
            Some("fallback-clean")
        );
        assert_eq!(
            fallbacks[0]
                .headers
                .get("authorization")
                .map(String::as_str),
            Some("Bearer sk-fallback")
        );
    }

    // 3. Same-name routing project `default`: only declared callModels are reachable.
    let passthrough = post_chat(
        &client,
        format!("{gw_url}/model/default/v1/chat/completions"),
        Some("lin-proj-default-secret"),
        "m-fallback",
        false,
    )
    .await;
    assert_eq!(passthrough.status(), StatusCode::OK);
    let passthrough_json: Value = passthrough.json().await.unwrap();
    assert_eq!(passthrough_json["model"], json!("m-fallback"));

    // An upstream model that exists but is not declared as a callModel must not be callable,
    // neither by bare id nor by `provider/model`.
    for undeclared in ["m-primary", "fallback-prov/m-fallback", "*"] {
        let resp = post_chat(
            &client,
            format!("{gw_url}/model/default/v1/chat/completions"),
            Some("lin-proj-default-secret"),
            undeclared,
            false,
        )
        .await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND, "{undeclared}");
    }

    // 4. `/models` lists exactly the project's declared callModels.
    let coding_models: Value = client
        .get(format!("{gw_url}/model/coding/v1/models"))
        .bearer_auth("lin-proj-coding-secret")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let coding_ids: Vec<&str> = coding_models["data"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|m| m["id"].as_str())
        .collect();
    assert_eq!(coding_ids, vec!["smart-coder"]);

    let default_models: Value = client
        .get(format!("{gw_url}/model/default/v1/models"))
        .bearer_auth("lin-proj-default-secret")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let default_ids: Vec<&str> = default_models["data"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|m| m["id"].as_str())
        .collect();
    assert_eq!(default_ids, vec!["m-fallback"]);

    let models_unauth = client
        .get(format!("{gw_url}/model/coding/v1/models"))
        .send()
        .await
        .unwrap();
    assert_eq!(models_unauth.status(), StatusCode::UNAUTHORIZED);

    // 5. Removed legacy endpoints answer 404 (even with valid keys and the old project header).
    for legacy in [
        "/v1/chat/completions",
        "/g/default/v1/chat/completions",
        "/p/fallback-prov/v1/chat/completions",
    ] {
        let resp = client
            .post(format!("{gw_url}{legacy}"))
            .bearer_auth("lin-proj-default-secret")
            .header("x-linguist-project", "default")
            .json(&json!({"model": "m-fallback", "messages": []}))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND, "{legacy}");
        let body: Value = resp.json().await.unwrap();
        assert!(
            body["error"]["message"]
                .as_str()
                .unwrap()
                .contains("/model/{project_id}/v1"),
            "{legacy}"
        );
    }
    let legacy_models = client
        .get(format!("{gw_url}/v1/models"))
        .bearer_auth("lin-proj-default-secret")
        .send()
        .await
        .unwrap();
    assert_eq!(legacy_models.status(), StatusCode::NOT_FOUND);

    // 6. Health check `/healthz` and built-in read-only icon fallback `/icons/*`
    let health = client
        .get(format!("{gw_url}/healthz"))
        .send()
        .await
        .unwrap();
    assert_eq!(health.status(), StatusCode::OK);

    let builtin_icon = client
        .get(format!("{gw_url}/icons/deepseek-color.svg"))
        .send()
        .await
        .unwrap();
    assert_eq!(builtin_icon.status(), StatusCode::OK);
    let icon_body = builtin_icon.text().await.unwrap();
    assert!(icon_body.contains("<svg"));

    let openai_icon = client
        .get(format!("{gw_url}/icons/openai.svg"))
        .send()
        .await
        .unwrap();
    assert_eq!(openai_icon.status(), StatusCode::OK);
    let openai_body = openai_icon.text().await.unwrap();
    assert!(openai_body.contains("currentColor"));
    assert!(openai_body.contains("<path"));

    let doubao_icon = client
        .get(format!("{gw_url}/icons/doubao-color.svg"))
        .send()
        .await
        .unwrap();
    assert_eq!(doubao_icon.status(), StatusCode::OK);
    assert!(doubao_icon.text().await.unwrap().contains("Doubao"));

    let monochrome_icon = client
        .get(format!("{gw_url}/icons/lobehub.svg"))
        .send()
        .await
        .unwrap();
    assert_eq!(monochrome_icon.status(), StatusCode::OK);

    let missing_icon = client
        .get(format!("{gw_url}/icons/nonexistent-custom.svg"))
        .send()
        .await
        .unwrap();
    assert_eq!(missing_icon.status(), StatusCode::NOT_FOUND);
}
