//! L2 HTTP end-to-end integration tests for the Linguist `OpenAI` gateway.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

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

/// Mock primary upstream endpoint returning HTTP 429 rate-limit.
async fn mock_primary_429(
    State(state): State<MockUpstreamState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    state
        .primary_calls
        .lock()
        .unwrap()
        .push(capture_call(&headers, body));
    (
        StatusCode::TOO_MANY_REQUESTS,
        Json(json!({ "error": { "message": "rate limited", "type": "rate_limit_error" } })),
    )
        .into_response()
}

/// Mock fallback upstream endpoint supporting both streaming SSE and JSON chat responses.
async fn mock_fallback_ok(
    State(state): State<MockUpstreamState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let is_stream = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();

    state
        .fallback_calls
        .lock()
        .unwrap()
        .push(capture_call(&headers, body));

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
        .route("/primary/v1/chat/completions", post(mock_primary_429))
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
            }),
            fallbacks: vec![RouteEndpoint {
                provider_id: "fallback-prov".to_string(),
                model_id: "m-fallback".to_string(),
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
    let catalog = Arc::new(ArcSwap::from_pointee(build_e2e_catalog(mock_base_url)));
    let cfg = AppConfig::default();
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

    // 6. Health check `/healthz`
    let health = client
        .get(format!("{gw_url}/healthz"))
        .send()
        .await
        .unwrap();
    assert_eq!(health.status(), StatusCode::OK);
}
