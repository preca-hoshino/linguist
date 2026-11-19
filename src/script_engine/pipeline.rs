//! Five-stage unidirectional outbound routing pipeline and Post-Stage-③ snapshot isolation.

use std::collections::BTreeMap;

use anyhow::{Result, anyhow};
use serde_json::{Map, Value};
use uuid::Uuid;

use crate::catalog::RuntimeCatalog;
use crate::metrics_cache::MetricsCache;
use crate::models::{
    CallModelMeta, ModelConfig, ProjectMeta, ProviderConfig, RejectDirective, RequestState,
    RouteEndpoint, RouteState, ScriptContext, ScriptStage, extract_request_signals,
    normalize_chat_completions_url,
};
use crate::script_engine::ScriptEngine;

/// Prepared routing plan after running Stages ① -> ③ (or direct `/p/{provider}` setup).
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

/// Runs Stages ① (`project`), ② (`callModel`), and ③ (`route`) to produce a
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
                "Project '{project_id}' or call model '{requested_model}' is not configured"
            ),
        }));
    };

    let Some(rule) = catalog.match_route_rule(&project.id, requested_model) else {
        return Ok(StageOutcome::Rejected(RejectDirective {
            status_code: 404,
            message: format!(
                "No enabled route rule matches project '{}' and model '{requested_model}'",
                project.id
            ),
        }));
    };

    let candidates = catalog.build_candidates(rule, |pid, mid| metrics.get_metrics(pid, mid));
    let signals = extract_request_signals(&incoming_body);
    let mut headers = BTreeMap::new();
    headers.insert("content-type".to_string(), "application/json".to_string());

    let mut ctx = ScriptContext {
        stage: ScriptStage::Project,
        project: project.to_meta(),
        call_model: call_model.to_meta(requested_model),
        provider: None,
        model: None,
        route: RouteState {
            rule_id: rule.id.clone(),
            candidates,
            target: rule.target.clone(),
            fallbacks: rule.fallbacks.clone(),
            rewrite_response_model: rule.rewrite_response_model,
        },
        request: RequestState {
            uid: request_uid.to_string(),
            attempt: 1,
            url: String::new(),
            headers,
            body: incoming_body,
            signals,
        },
        state: Map::new(),
        reject: None,
    };

    // Stage ①: Project script
    if let Some(script) = project.script.as_deref() {
        ctx = engine.execute(script, &ctx).await?;
        if let Some(reject) = ctx.reject.take() {
            return Ok(StageOutcome::Rejected(reject));
        }
    }

    // Stage ②: CallModel script
    ctx.stage = ScriptStage::CallModel;
    if let Some(script) = call_model.script.as_deref() {
        ctx = engine.execute(script, &ctx).await?;
        if let Some(reject) = ctx.reject.take() {
            return Ok(StageOutcome::Rejected(reject));
        }
    }

    // Stage ③: Route script
    ctx.stage = ScriptStage::Route;
    if let Some(script) = rule.script.as_deref() {
        ctx = engine.execute(script, &ctx).await?;
        if let Some(reject) = ctx.reject.take() {
            return Ok(StageOutcome::Rejected(reject));
        }
    }

    let Some(primary) = ctx.route.target.clone() else {
        return Ok(StageOutcome::Rejected(RejectDirective {
            status_code: 404,
            message: format!("Route rule '{}' did not select a target model", rule.id),
        }));
    };

    let mut endpoints = Vec::with_capacity(1 + ctx.route.fallbacks.len());
    endpoints.push(primary);
    for fb in &ctx.route.fallbacks {
        if !endpoints.contains(fb) {
            endpoints.push(fb.clone());
        }
    }

    let call_model_name = if call_model.id == "*" {
        requested_model.to_string()
    } else {
        call_model.name.clone()
    };

    Ok(StageOutcome::Ready(RoutingPlan {
        project_name: project.name.clone(),
        call_model_name,
        endpoints,
        snapshot_ctx: ctx,
    }))
}

/// Builds a direct provider-debug `RoutingPlan` for `/p/{provider_id}/v1/chat/completions`,
/// skipping Stages ①..③ while still preparing Stage ④ & ⑤ execution and telemetry.
#[must_use]
pub fn build_direct_provider_plan(
    provider: &ProviderConfig,
    model: &ModelConfig,
    request_uid: Uuid,
    incoming_body: Map<String, Value>,
) -> RoutingPlan {
    let signals = extract_request_signals(&incoming_body);
    let mut headers = BTreeMap::new();
    headers.insert("content-type".to_string(), "application/json".to_string());

    let endpoint = RouteEndpoint {
        provider_id: provider.id.clone(),
        model_id: model.id.clone(),
    };

    let snapshot_ctx = ScriptContext {
        stage: ScriptStage::Route,
        project: ProjectMeta {
            id: "direct".to_string(),
            name: "Direct Provider".to_string(),
            icon: Some(provider.icon.clone()),
            meta: Map::new(),
        },
        call_model: CallModelMeta {
            id: model.id.clone(),
            name: model.name.clone(),
            icon: Some(model.icon.clone()),
            meta: Map::new(),
        },
        provider: None,
        model: None,
        route: RouteState {
            rule_id: "direct-provider".to_string(),
            candidates: Vec::new(),
            target: Some(endpoint.clone()),
            fallbacks: Vec::new(),
            rewrite_response_model: false,
        },
        request: RequestState {
            uid: request_uid.to_string(),
            attempt: 1,
            url: String::new(),
            headers,
            body: incoming_body,
            signals,
        },
        state: Map::new(),
        reject: None,
    };

    RoutingPlan {
        project_name: "Direct Provider".to_string(),
        call_model_name: model.name.clone(),
        endpoints: vec![endpoint],
        snapshot_ctx,
    }
}

/// Clones the Post-Stage-③ snapshot and executes Stages ④ (`model`) and ⑤ (`provider`)
/// cleanly for a specific upstream `(provider, model)` attempt.
///
/// # Errors
/// Returns an error if script execution fails unexpectedly.
pub async fn prepare_attempt_context(
    snapshot: &ScriptContext,
    attempt: u16,
    provider: &ProviderConfig,
    model: &ModelConfig,
    engine: &ScriptEngine,
) -> Result<StageOutcome<ScriptContext>> {
    let mut ctx = snapshot.clone();
    ctx.request.attempt = attempt;
    ctx.provider = Some(provider.to_meta());
    ctx.model = Some(model.to_meta());
    ctx.request.url = normalize_chat_completions_url(&model.url);
    ctx.request
        .body
        .insert("model".to_string(), Value::String(model.id.clone()));

    // Stage ④: Model script
    ctx.stage = ScriptStage::Model;
    if let Some(script) = model.script.as_deref() {
        ctx = engine.execute(script, &ctx).await?;
        if let Some(reject) = ctx.reject.take() {
            return Ok(StageOutcome::Rejected(reject));
        }
    }

    // Stage ⑤: Provider script
    ctx.stage = ScriptStage::Provider;
    if let Some(script) = provider.script.as_deref() {
        ctx = engine.execute(script, &ctx).await?;
        if let Some(reject) = ctx.reject.take() {
            return Ok(StageOutcome::Rejected(reject));
        }
    }

    if ctx.request.url.trim().is_empty() {
        return Err(anyhow!(
            "Stage ④/⑤ left outbound request URL empty for {}/{}",
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
    use crate::config::{MetricsConfig, ScriptEngineConfig};
    use crate::models::{
        CallModelConfig, ProjectConfig, RouteCandidatesFilter, RouteMatchConfig, RouteRuleConfig,
    };

    fn build_fallback_test_catalog() -> RuntimeCatalog {
        let primary_model = ModelConfig {
            id: "primary-m".to_string(),
            name: "Primary".to_string(),
            icon: "openai".to_string(),
            url: "http://127.0.0.1:9991/v1".to_string(),
            supports_reasoning_effort: Some(vec!["xhigh".to_string()]),
            tool_calling: Some(true),
            vision: Some(false),
            thinking: Some(true),
            streaming: Some(true),
            max_input_tokens: Some(128_000),
            max_output_tokens: Some(16_000),
            script: Some(
                "ctx.request.body.reasoning_effort = 'xhigh'; \
                 ctx.request.headers['x-primary-only'] = 'polluted'; \
                 ctx.state.touched_by_primary = true;"
                    .to_string(),
            ),
        };
        let fallback_model = ModelConfig {
            id: "fallback-m".to_string(),
            name: "Fallback".to_string(),
            icon: "qwen-color".to_string(),
            url: "http://127.0.0.1:9992".to_string(),
            supports_reasoning_effort: Some(vec!["high".to_string()]),
            tool_calling: Some(true),
            vision: Some(false),
            thinking: Some(true),
            streaming: Some(true),
            max_input_tokens: Some(128_000),
            max_output_tokens: Some(16_000),
            script: None,
        };

        RuntimeCatalog::new(
            vec![
                ProviderConfig {
                    id: "p1".to_string(),
                    name: "Provider 1".to_string(),
                    icon: "openai".to_string(),
                    api_key: "sk-p1".to_string(),
                    script: None,
                    models: vec![primary_model],
                },
                ProviderConfig {
                    id: "p2".to_string(),
                    name: "Provider 2".to_string(),
                    icon: "qwen-color".to_string(),
                    api_key: "sk-p2".to_string(),
                    script: Some("ctx.request.headers['x-p2'] = 'clean';".to_string()),
                    models: vec![fallback_model],
                },
            ],
            vec![ProjectConfig {
                id: "coding".to_string(),
                name: "Coding".to_string(),
                api_key: None,
                icon: "githubcopilot".to_string(),
                meta: Map::new(),
                script: Some("ctx.state.from_stage_1 = 'yes';".to_string()),
                call_models: vec![CallModelConfig {
                    id: "smart".to_string(),
                    name: "Smart".to_string(),
                    icon: "cursor".to_string(),
                    meta: Map::new(),
                    script: Some("ctx.request.body.reasoning_effort = 'high';".to_string()),
                }],
            }],
            vec![RouteRuleConfig {
                id: "r-smart".to_string(),
                name: "Smart Route".to_string(),
                enabled: true,
                priority: 10,
                match_rule: RouteMatchConfig {
                    project_ids: vec!["coding".to_string()],
                    call_model_ids: vec!["smart".to_string()],
                },
                candidates: RouteCandidatesFilter::default(),
                target: Some(RouteEndpoint {
                    provider_id: "p1".to_string(),
                    model_id: "primary-m".to_string(),
                }),
                fallbacks: vec![RouteEndpoint {
                    provider_id: "p2".to_string(),
                    model_id: "fallback-m".to_string(),
                }],
                rewrite_response_model: true,
                script: None,
            }],
        )
    }

    #[tokio::test]
    async fn post_stage_3_snapshot_isolates_fallback_from_primary_mutations() {
        let catalog = build_fallback_test_catalog();
        let metrics = MetricsCache::new(&MetricsConfig::default());
        let engine = ScriptEngine::new(ScriptEngineConfig::default());
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
        assert!(plan_res.is_ok());
        let Ok(StageOutcome::Ready(plan)) = plan_res else {
            return;
        };

        let Some((p1, m1)) = catalog.find_model("p1", "primary-m") else {
            return;
        };
        let att1 = prepare_attempt_context(&plan.snapshot_ctx, 1, p1, m1, &engine).await;
        assert!(att1.is_ok());
        if let Ok(StageOutcome::Ready(ctx1)) = att1 {
            assert_eq!(
                ctx1.request.body.get("reasoning_effort"),
                Some(&json!("xhigh"))
            );
            assert!(ctx1.request.headers.contains_key("x-primary-only"));
        }

        let Some((p2, m2)) = catalog.find_model("p2", "fallback-m") else {
            return;
        };
        let att2 = prepare_attempt_context(&plan.snapshot_ctx, 2, p2, m2, &engine).await;
        assert!(att2.is_ok());
        if let Ok(StageOutcome::Ready(ctx2)) = att2 {
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
            assert_eq!(ctx2.state.get("from_stage_1"), Some(&json!("yes")));
            assert!(!ctx2.state.contains_key("touched_by_primary"));
        }
    }
}
