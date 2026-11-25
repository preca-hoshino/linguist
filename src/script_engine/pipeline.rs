//! Five-stage ordered multi-script outbound routing pipeline and Post-Stage-③ snapshot isolation.

use std::collections::BTreeMap;

use anyhow::{Result, anyhow};
use serde_json::{Map, Value};
use uuid::Uuid;

use crate::catalog::RuntimeCatalog;
use crate::metrics_cache::MetricsCache;
use crate::models::{
    CompiledScriptUnit, ModelConfig, ProviderConfig, RejectDirective, RequestState, RouteEndpoint,
    RouteState, ScriptContext, ScriptStage, extract_request_signals,
    normalize_chat_completions_url,
};
use crate::script_engine::ScriptEngine;

/// Prepared routing plan after running Stages ① -> ③.
#[derive(Debug, Clone)]
pub struct RoutingPlan {
    /// Consume-side project display name.
    pub project_name: String,
    /// Consume-side call model display name.
    pub call_model_name: String,
    /// Ordered list of upstream targets: `[primary, fallback1, fallback2, ...]`.
    pub endpoints: Vec<RouteEndpoint>,
    /// Immutable Post-Stage-③ context snapshot cloned before each attempt's Stages ④ & ⑤.
    pub snapshot_ctx: ScriptContext,
}

/// Outcome returned by Stages ①..③ or ④..⑤ preparation.
#[derive(Debug, Clone)]
pub enum StageOutcome<T> {
    /// Proceed with the prepared value.
    Ready(T),
    /// Reject the request immediately with HTTP status code and message.
    Rejected(RejectDirective),
}

/// Runs an entity's compiled `onRequest` units in order, short-circuiting on `ctx.reject`.
async fn execute_request_chain(
    engine: &ScriptEngine,
    units: &[CompiledScriptUnit],
    mut ctx: ScriptContext,
) -> Result<StageOutcome<ScriptContext>> {
    for unit in units {
        if !unit.has_on_request {
            continue;
        }
        ctx = engine.execute_request_unit(unit, &ctx).await?;
        if let Some(reject) = ctx.reject.take() {
            return Ok(StageOutcome::Rejected(reject));
        }
    }
    Ok(StageOutcome::Ready(ctx))
}

/// Runs Stages ① (`project`), ② (`callModel`), and ③ (ordered `routes[]`) to produce a
/// `RoutingPlan` containing the ordered endpoints and the Post-Stage-③ snapshot.
///
/// # Errors
/// Returns an error if script execution fails unexpectedly.
pub async fn run_routing_stages(
    catalog: &RuntimeCatalog,
    metrics: &MetricsCache,
    engine: &ScriptEngine,
    request_uid: Uuid,
    project_id: &str,
    requested_model: &str,
    incoming_body: Map<String, Value>,
) -> Result<StageOutcome<RoutingPlan>> {
    let Some((project, call_model)) =
        catalog.resolve_project_and_call_model(project_id, requested_model)
    else {
        return Ok(StageOutcome::Rejected(RejectDirective {
            status_code: 404,
            message: format!(
                "Project '{project_id}' or call model '{requested_model}' is not configured or disabled"
            ),
        }));
    };

    let candidates = catalog.build_all_candidates(|pid, mid| metrics.get_metrics(pid, mid));
    let signals = extract_request_signals(&incoming_body);
    let mut headers = BTreeMap::new();
    headers.insert("content-type".to_string(), "application/json".to_string());

    let mut ctx = ScriptContext {
        stage: ScriptStage::Project,
        project: project.to_entity_info(),
        call_model: call_model.to_entity_info(),
        route_info: None,
        provider: None,
        model: None,
        route: RouteState {
            rule_id: None,
            candidates,
            target: None,
            fallbacks: Vec::new(),
            continue_routing: false,
            rewrite_response_model: false,
        },
        request: RequestState {
            uid: request_uid.to_string(),
            attempt: 1,
            url: String::new(),
            headers,
            body: incoming_body,
            inject_stream_options: true,
            timeout_secs: None,
            retry_status_codes: None,
            signals,
        },
        state: Map::new(),
        reject: None,
    };

    // Stage ①: Project script chain
    ctx = match execute_request_chain(engine, &project.compiled.units, ctx).await? {
        StageOutcome::Ready(next) => next,
        StageOutcome::Rejected(rej) => return Ok(StageOutcome::Rejected(rej)),
    };

    // Stage ②: CallModel script chain
    ctx.stage = ScriptStage::CallModel;
    ctx = match execute_request_chain(engine, &call_model.compiled.units, ctx).await? {
        StageOutcome::Ready(next) => next,
        StageOutcome::Rejected(rej) => return Ok(StageOutcome::Rejected(rej)),
    };

    // Stage ③: Ordered Route responsibility chain
    ctx.stage = ScriptStage::Route;
    for rule in &catalog.routes {
        if !rule.enabled {
            continue;
        }
        ctx.route_info = Some(rule.to_entity_info());
        ctx = match execute_request_chain(engine, &rule.compiled.units, ctx).await? {
            StageOutcome::Ready(next) => next,
            StageOutcome::Rejected(rej) => return Ok(StageOutcome::Rejected(rej)),
        };

        if ctx.route.target.is_some() {
            ctx.route.rule_id = Some(rule.id.clone());
            if !ctx.route.continue_routing {
                break;
            }
            ctx.route.continue_routing = false;
        }
    }
    ctx.route_info = None;

    let Some(primary) = ctx.route.target.clone() else {
        return Ok(StageOutcome::Rejected(RejectDirective {
            status_code: 404,
            message: format!(
                "No enabled route selected a target model for '{project_id}/{requested_model}'"
            ),
        }));
    };

    let mut endpoints = Vec::with_capacity(1 + ctx.route.fallbacks.len());
    for endpoint in std::iter::once(&primary).chain(&ctx.route.fallbacks) {
        if !endpoints.iter().any(|existing: &RouteEndpoint| {
            existing.provider_id == endpoint.provider_id && existing.model_id == endpoint.model_id
        }) {
            endpoints.extend(std::iter::repeat_n(
                endpoint.clone(),
                usize::from(endpoint.max_attempts),
            ));
        }
    }

    Ok(StageOutcome::Ready(RoutingPlan {
        project_name: project.name.clone(),
        call_model_name: call_model.name.clone(),
        endpoints,
        snapshot_ctx: ctx,
    }))
}

/// Clones the Post-Stage-③ snapshot and executes Stages ④ (`model`) and ⑤ (`provider`)
/// cleanly for a specific upstream `(provider, model)` attempt.
///
/// # Errors
/// Returns an error if script execution fails unexpectedly or leaves the URL empty.
pub async fn prepare_attempt_context(
    snapshot: &ScriptContext,
    attempt: u16,
    provider: &ProviderConfig,
    model: &ModelConfig,
    engine: &ScriptEngine,
) -> Result<StageOutcome<ScriptContext>> {
    let mut ctx = snapshot.clone();
    ctx.request.attempt = attempt;
    ctx.provider = Some(provider.to_provider_info());
    ctx.model = Some(model.to_entity_info());

    let default_base = model
        .compiled
        .meta
        .get("url")
        .and_then(Value::as_str)
        .or_else(|| {
            provider
                .compiled
                .meta
                .get("baseUrl")
                .and_then(Value::as_str)
        })
        .unwrap_or("");
    ctx.request.url = normalize_chat_completions_url(default_base);

    let upstream_model = model
        .compiled
        .meta
        .get("upstreamModel")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&model.id);
    ctx.request.body.insert(
        "model".to_string(),
        Value::String(upstream_model.to_string()),
    );

    // Stage ④: Model script chain
    ctx.stage = ScriptStage::Model;
    ctx = match execute_request_chain(engine, &model.compiled.units, ctx).await? {
        StageOutcome::Ready(next) => next,
        StageOutcome::Rejected(rej) => return Ok(StageOutcome::Rejected(rej)),
    };

    // Stage ⑤: Provider script chain
    ctx.stage = ScriptStage::Provider;
    ctx = match execute_request_chain(engine, &provider.compiled.units, ctx).await? {
        StageOutcome::Ready(next) => next,
        StageOutcome::Rejected(rej) => return Ok(StageOutcome::Rejected(rej)),
    };

    if ctx.request.url.trim().is_empty() {
        return Err(anyhow!(
            "Stage ④/⑤ left outbound request URL empty for {}/{} (set meta.url/baseUrl or ctx.request.url)",
            provider.id,
            model.id
        ));
    }

    Ok(StageOutcome::Ready(ctx))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::config::ScriptEngineConfig;
    use crate::models::{CallModelConfig, ProjectConfig, RouteRuleConfig, ScriptItem};

    fn make_chain(
        engine: &ScriptEngine,
        code: &str,
    ) -> (Vec<ScriptItem>, crate::models::CompiledScriptChain) {
        let items = vec![ScriptItem {
            id: "s1".to_string(),
            name: "Main".to_string(),
            enabled: true,
            code: code.to_string(),
        }];
        let compiled = engine.compile_chain(&items).unwrap_or_default();
        (items, compiled)
    }

    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn ordered_routes_and_post_stage_3_snapshot_isolation_work() {
        let engine = ScriptEngine::new(ScriptEngineConfig::default());

        let (m1_scripts, m1_comp) = make_chain(
            &engine,
            r#"
            export const tags = ["thinking"];
            export const meta = { url: "http://127.0.0.1:9991/v1" };
            export function onRequest(ctx: ScriptContext) {
                ctx.request.body.reasoning_effort = "xhigh";
                ctx.request.headers["x-primary-only"] = "polluted";
                ctx.state.touched_by_primary = true;
            }
            "#,
        );
        let (m2_scripts, m2_comp) = make_chain(
            &engine,
            r#"
            export const meta = { url: "http://127.0.0.1:9992" };
            "#,
        );
        let (p2_scripts, p2_comp) = make_chain(
            &engine,
            "export function onRequest(ctx: ScriptContext) { ctx.request.headers['x-p2'] = 'clean'; }",
        );
        let (proj_scripts, proj_comp) = make_chain(
            &engine,
            "export function onRequest(ctx: ScriptContext) { ctx.state.from_stage_1 = 'yes'; }",
        );
        let (cm_scripts, cm_comp) = make_chain(
            &engine,
            "export function onRequest(ctx: ScriptContext) { ctx.request.body.reasoning_effort = 'high'; }",
        );
        let (r1_scripts, r1_comp) = make_chain(
            &engine,
            r"
            export function onRequest(ctx: ScriptContext) {
                // Route 1 filters out nothing and passes through without setting target.
                ctx.state.guard_ran = true;
            }
            ",
        );
        let (r2_scripts, r2_comp) = make_chain(
            &engine,
            r#"
            export function onRequest(ctx: ScriptContext) {
                ctx.route.rewriteResponseModel = true;
                ctx.route.target = { providerId: "p1", modelId: "primary-m" };
                ctx.route.fallbacks = [{ providerId: "p2", modelId: "fallback-m" }];
            }
            "#,
        );

        let catalog = RuntimeCatalog::new(
            vec![
                ProviderConfig {
                    id: "p1".to_string(),
                    name: "P1".to_string(),
                    icon: "openai".to_string(),
                    enabled: true,
                    api_key: "sk-p1".to_string(),
                    scripts: Vec::new(),
                    compiled: crate::models::CompiledScriptChain::default(),
                    models: vec![ModelConfig {
                        id: "primary-m".to_string(),
                        name: "Primary".to_string(),
                        icon: "openai".to_string(),
                        enabled: true,
                        scripts: m1_scripts,
                        compiled: m1_comp,
                    }],
                },
                ProviderConfig {
                    id: "p2".to_string(),
                    name: "P2".to_string(),
                    icon: "qwen-color".to_string(),
                    enabled: true,
                    api_key: "sk-p2".to_string(),
                    scripts: p2_scripts,
                    compiled: p2_comp,
                    models: vec![ModelConfig {
                        id: "fallback-m".to_string(),
                        name: "Fallback".to_string(),
                        icon: "qwen-color".to_string(),
                        enabled: true,
                        scripts: m2_scripts,
                        compiled: m2_comp,
                    }],
                },
            ],
            vec![ProjectConfig {
                id: "coding".to_string(),
                name: "Coding".to_string(),
                icon: "githubcopilot".to_string(),
                enabled: true,
                api_key: "lin-proj-coding".to_string(),
                scripts: proj_scripts,
                compiled: proj_comp,
                call_models: vec![CallModelConfig {
                    id: "smart".to_string(),
                    name: "Smart".to_string(),
                    icon: "cursor".to_string(),
                    enabled: true,
                    scripts: cm_scripts,
                    compiled: cm_comp,
                }],
            }],
            vec![
                RouteRuleConfig {
                    id: "r-guard".to_string(),
                    name: "Guard".to_string(),
                    icon: "route".to_string(),
                    enabled: true,
                    position: 0,
                    scripts: r1_scripts,
                    compiled: r1_comp,
                },
                RouteRuleConfig {
                    id: "r-smart".to_string(),
                    name: "Smart Route".to_string(),
                    icon: "route".to_string(),
                    enabled: true,
                    position: 1,
                    scripts: r2_scripts,
                    compiled: r2_comp,
                },
            ],
        );

        let metrics = MetricsCache::new(&crate::config::MetricsConfig::default());
        let mut body = Map::new();
        body.insert("model".to_string(), json!("smart"));
        body.insert(
            "messages".to_string(),
            json!([{"role": "user", "content": "hi"}]),
        );

        let plan_res = run_routing_stages(
            &catalog,
            &metrics,
            &engine,
            Uuid::new_v4(),
            "coding",
            "smart",
            body,
        )
        .await;
        assert!(plan_res.is_ok(), "plan failed: {plan_res:?}");
        let Ok(StageOutcome::Ready(plan)) = plan_res else {
            return;
        };
        assert_eq!(plan.snapshot_ctx.route.rule_id.as_deref(), Some("r-smart"));
        assert_eq!(plan.snapshot_ctx.state.get("guard_ran"), Some(&json!(true)));

        let Some((p1, m1)) = catalog.find_model("p1", "primary-m") else {
            return;
        };
        let Ok(StageOutcome::Ready(ctx1)) =
            prepare_attempt_context(&plan.snapshot_ctx, 1, p1, m1, &engine).await
        else {
            return;
        };
        assert_eq!(
            ctx1.request.body.get("reasoning_effort"),
            Some(&json!("xhigh"))
        );
        assert!(ctx1.request.headers.contains_key("x-primary-only"));

        let Some((p2, m2)) = catalog.find_model("p2", "fallback-m") else {
            return;
        };
        let Ok(StageOutcome::Ready(ctx2)) =
            prepare_attempt_context(&plan.snapshot_ctx, 2, p2, m2, &engine).await
        else {
            return;
        };
        assert_eq!(ctx2.request.attempt, 2);
        assert_eq!(
            ctx2.request.body.get("reasoning_effort"),
            Some(&json!("high"))
        );
        assert_eq!(ctx2.request.body.get("model"), Some(&json!("fallback-m")));
        assert_eq!(
            ctx2.request.url,
            "http://127.0.0.1:9992/v1/chat/completions"
        );
        assert!(!ctx2.request.headers.contains_key("x-primary-only"));
        assert_eq!(
            ctx2.request.headers.get("x-p2").map(String::as_str),
            Some("clean")
        );
        assert!(!ctx2.state.contains_key("touched_by_primary"));
    }
}
