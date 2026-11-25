//! TypeScript/JavaScript multi-script compiler, `LocalSet` async sandbox pool,
//! and 5-stage ordered outbound routing pipeline.

pub mod compiler;
pub mod pipeline;
pub mod runtime;

use std::sync::Arc;

use anyhow::Result;

use crate::catalog::RuntimeCatalog;
use crate::config::ScriptEngineConfig;
use crate::models::{CompiledScriptChain, CompiledScriptUnit, ScriptContext, ScriptItem};
use crate::script_engine::compiler::compile_script_chain;
use crate::script_engine::pipeline::StageOutcome;
use crate::script_engine::runtime::{BillingExecutionOutput, BillingInput, ScriptRuntimePool};

/// Sandboxed TypeScript-to-JavaScript execution engine backed by `boa_engine`.
#[derive(Debug, Clone)]
pub struct ScriptEngine {
    /// Runtime sandbox configuration.
    config: Arc<ScriptEngineConfig>,
    /// Dedicated `LocalSet` worker pool for async `onRequest` & `onBilling` execution.
    pool: ScriptRuntimePool,
}

impl ScriptEngine {
    /// Creates a new `ScriptEngine` from configuration and starts the `LocalSet` worker pool.
    #[must_use]
    pub fn new(config: ScriptEngineConfig) -> Self {
        let cfg = Arc::new(config);
        let pool = ScriptRuntimePool::new(Arc::clone(&cfg));
        Self { config: cfg, pool }
    }

    /// Compiles and validates an entity's ordered `scripts[]` chain offline,
    /// extracting and merging `tags`, `meta`, and exported lifecycle hooks.
    ///
    /// # Errors
    /// Returns an error if any enabled script fails syntax/type-stripping or top-level evaluation.
    pub fn compile_chain(&self, scripts: &[ScriptItem]) -> Result<CompiledScriptChain> {
        compile_script_chain(scripts, self.config.timeout_ms, self.config.memory_limit_mb)
    }

    /// Executes a single compiled `onRequest` unit asynchronously against `input_ctx`.
    ///
    /// # Errors
    /// Returns an error if execution fails, times out, or exceeds sandbox limits.
    pub async fn execute_request_unit(
        &self,
        unit: &CompiledScriptUnit,
        input_ctx: &ScriptContext,
    ) -> Result<ScriptContext> {
        self.pool
            .execute_request_unit(unit.compile_id, &unit.js_code, input_ctx)
            .await
    }

    /// Executes Stages ①..③ (`project` -> `callModel` -> `routes[]`) in a single worker dispatch.
    ///
    /// # Errors
    /// Returns an error if execution fails, times out, or exceeds sandbox limits.
    pub async fn execute_routing_batch(
        &self,
        catalog: Arc<RuntimeCatalog>,
        project_id: &str,
        call_model_id: &str,
        input_ctx: ScriptContext,
    ) -> Result<StageOutcome<ScriptContext>> {
        self.pool
            .execute_routing_batch(catalog, project_id, call_model_id, input_ctx)
            .await
    }

    /// Executes Stages ④..⑤ (`model` -> `provider`) in a single worker dispatch.
    ///
    /// # Errors
    /// Returns an error if execution fails, times out, or exceeds sandbox limits.
    pub async fn execute_attempt_batch(
        &self,
        catalog: Arc<RuntimeCatalog>,
        provider_id: &str,
        model_id: &str,
        input_ctx: ScriptContext,
    ) -> Result<StageOutcome<ScriptContext>> {
        self.pool
            .execute_attempt_batch(catalog, provider_id, model_id, input_ctx)
            .await
    }

    /// Executes an ordered list of `onBilling` units (`Provider` -> `Model`) asynchronously.
    ///
    /// # Errors
    /// Returns an error if any billing script fails or returns invalid monetary values.
    pub async fn execute_billing_chain(
        &self,
        units: &[CompiledScriptUnit],
        input: &BillingInput,
    ) -> Result<BillingExecutionOutput> {
        self.pool.execute_billing_chain(units, input).await
    }

    /// Returns a snapshot of script execution and `linguist.http` cache metrics.
    #[must_use]
    pub fn runtime_stats(&self) -> crate::script_engine::runtime::ScriptRuntimeStats {
        self.pool.stats()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::{Map, json};

    use super::*;
    use crate::models::{
        CandidateItem, CandidateMetrics, EntityInfo, ProviderInfo, RequestSignals, RequestState,
        RouteEndpoint, RouteState, ScriptStage,
    };
    use crate::script_engine::runtime::{BillingTimings, BillingTokens};

    fn sample_entity(id: &str, name: &str) -> EntityInfo {
        EntityInfo {
            id: id.to_string(),
            name: name.to_string(),
            icon: "openai".to_string(),
            tags: vec!["tools".to_string()],
            meta: Map::new(),
        }
    }

    fn sample_context() -> ScriptContext {
        let mut proj_meta = Map::new();
        proj_meta.insert("maxCharsLimit".to_string(), json!(400_000));

        let mut body = Map::new();
        body.insert("model".to_string(), json!("smart-coder"));
        body.insert("temperature".to_string(), json!(0.7));
        body.insert(
            "messages".to_string(),
            json!([{"role": "user", "content": "hello"}]),
        );

        ScriptContext {
            stage: ScriptStage::Project,
            project: EntityInfo {
                id: "coding".to_string(),
                name: "VS Code Coding".to_string(),
                icon: "githubcopilot".to_string(),
                tags: Vec::new(),
                meta: proj_meta,
            },
            call_model: sample_entity("smart-coder", "Smart Coder"),
            route_info: None,
            provider: Some(ProviderInfo {
                id: "opencode".to_string(),
                name: "Opencode".to_string(),
                icon: "opencode".to_string(),
                tags: Vec::new(),
                meta: Map::new(),
                api_key: "sk-prov-secret".to_string(),
            }),
            model: Some(sample_entity("qwen3.8-max", "Qwen 3.8 Max")),
            route: RouteState {
                rule_id: None,
                candidates: vec![CandidateItem {
                    provider: sample_entity("opencode", "Opencode"),
                    model: sample_entity("qwen3.8-max", "Qwen 3.8 Max"),
                    metrics: CandidateMetrics::default(),
                }],
                target: None,
                fallbacks: Vec::new(),
                continue_routing: false,
                rewrite_response_model: true,
            },
            request: RequestState {
                uid: "00000000-0000-0000-0000-000000000001".to_string(),
                attempt: 1,
                url: "https://opencode.ai/zen/go/v1/chat/completions".to_string(),
                headers: BTreeMap::new(),
                body,
                inject_stream_options: true,
                timeout_secs: None,
                retry_status_codes: None,
                signals: RequestSignals {
                    is_stream: true,
                    has_vision_images: false,
                    has_tools: false,
                    message_count: 1,
                    estimated_input_chars: 5,
                },
            },
            state: Map::new(),
            reject: None,
        }
    }

    #[tokio::test]
    async fn compile_chain_merges_tags_meta_and_runs_ts_on_request() {
        let engine = ScriptEngine::new(ScriptEngineConfig::default());
        let chain = engine.compile_chain(&[
            ScriptItem {
                id: "s1".to_string(),
                name: "Base".to_string(),
                enabled: true,
                code: r#"
                    export const tags = ["tools", "vision"];
                    export const meta = { baseUrl: "https://a.example", maxTokens: 4096 };
                "#
                .to_string(),
            },
            ScriptItem {
                id: "s2".to_string(),
                name: "Override".to_string(),
                enabled: true,
                code: r#"
                    export const tags = ["vision", "thinking"];
                    export const meta = { maxTokens: 8192 };
                    export async function onRequest(ctx: ScriptContext): Promise<void> {
                        const limit: number = Number(ctx.project.meta.maxCharsLimit ?? 100);
                        ctx.project.id = "tampered";
                        ctx.request.headers["x-limit"] = String(limit);
                        delete ctx.request.body.temperature;
                        ctx.route.target = { providerId: "opencode", modelId: "qwen3.8-max" };
                    }
                "#
                .to_string(),
            },
        ]);
        assert!(chain.is_ok(), "compile failed: {chain:?}");
        let Ok(chain) = chain else { return };
        assert_eq!(chain.tags, vec!["tools", "vision", "thinking"]);
        assert_eq!(chain.meta.get("baseUrl"), Some(&json!("https://a.example")));
        assert_eq!(chain.meta.get("maxTokens"), Some(&json!(8192)));
        assert_eq!(chain.hooks, vec!["onRequest"]);
        assert_eq!(chain.units.len(), 1);

        let initial = sample_context();
        let out = engine.execute_request_unit(&chain.units[0], &initial).await;
        assert!(out.is_ok(), "exec failed: {out:?}");
        if let Ok(out) = out {
            assert_eq!(out.project.id, "coding");
            assert_eq!(
                out.request.headers.get("x-limit").map(String::as_str),
                Some("400000")
            );
            assert!(!out.request.body.contains_key("temperature"));
            assert_eq!(
                out.route.target,
                Some(RouteEndpoint {
                    provider_id: "opencode".to_string(),
                    model_id: "qwen3.8-max".to_string(),
                    max_attempts: 1,
                })
            );
        }
    }

    #[tokio::test]
    async fn infinite_loop_is_aborted_within_cpu_budget() {
        let engine = ScriptEngine::new(ScriptEngineConfig {
            timeout_ms: 50,
            ..ScriptEngineConfig::default()
        });
        let chain = engine.compile_chain(&[ScriptItem {
            id: "loop".to_string(),
            name: "Loop".to_string(),
            enabled: true,
            code: "export function onRequest() { while (true) {} }".to_string(),
        }]);
        assert!(chain.is_ok());
        if let Ok(chain) = chain {
            let res = engine
                .execute_request_unit(&chain.units[0], &sample_context())
                .await;
            assert!(res.is_err());
        }
    }

    #[tokio::test]
    async fn billing_chain_supports_decimal_math_and_sequential_draft_items() {
        let engine = ScriptEngine::new(ScriptEngineConfig::default());
        let prov_chain = engine
            .compile_chain(&[ScriptItem {
                id: "p-bill".to_string(),
                name: "Provider Base".to_string(),
                enabled: true,
                code: r#"
                    export function onBilling(b: BillingContext) {
                        b.draft.setCurrency("CNY");
                        b.draft.addInput("输入", linguist.costPerMillion(b.tokens.input, "2.0"));
                        b.draft.addOutput("输出", linguist.costPerMillion(b.tokens.output, "8.0"));
                    }
                "#
                .to_string(),
            }])
            .ok();
        let model_chain = engine
            .compile_chain(&[ScriptItem {
                id: "m-bill".to_string(),
                name: "Model Surcharge".to_string(),
                enabled: true,
                code: r#"
                    export function onBilling(b: BillingContext) {
                        b.draft.addOther("缓存存储", "0.005");
                        b.draft.setMeta("note", "ok");
                    }
                "#
                .to_string(),
            }])
            .ok();

        let (Some(p_c), Some(m_c)) = (prov_chain, model_chain) else {
            return;
        };
        let mut units = p_c.units;
        units.extend(m_c.units);

        let input = BillingInput {
            request_started_at_utc: "2026-11-25T10:00:00Z".to_string(),
            completed_at_utc: "2026-11-25T10:00:02Z".to_string(),
            attempt: 1,
            status_code: 200,
            is_stream: true,
            interrupted: false,
            project: sample_entity("coding", "Coding"),
            call_model: sample_entity("smart-coder", "Smart Coder"),
            provider: ProviderInfo {
                id: "deepseek".to_string(),
                name: "DeepSeek".to_string(),
                icon: "deepseek-color".to_string(),
                tags: Vec::new(),
                meta: Map::new(),
                api_key: "sk-test".to_string(),
            },
            model: sample_entity("deepseek-v4", "DeepSeek V4"),
            state: json!({}),
            timings: BillingTimings {
                ttft_ms: 120.0,
                total_duration_ms: 1000.0,
                generation_duration_ms: 880.0,
                decode_tps: 100.0,
            },
            tokens: BillingTokens {
                input: 1_000_000,
                output: 500_000,
                cache_read: 0,
                cache_creation: 0,
                reasoning: 0,
                total: 1_500_000,
                extra: BTreeMap::new(),
                source: "upstream_usage".to_string(),
            },
            raw_usage: Some(json!({ "prompt_tokens": 1_000_000, "completion_tokens": 500_000 })),
        };

        let out = engine.execute_billing_chain(&units, &input).await;
        assert!(out.is_ok(), "billing failed: {out:?}");
        if let Ok(out) = out {
            assert_eq!(out.currency.as_deref(), Some("CNY"));
            assert_eq!(out.status, "priced");
            assert_eq!(
                out.amount.map(|d| d.normalize().to_string()),
                Some("6.005".to_string())
            );
            assert_eq!(out.details["inputAmount"], "2");
            assert_eq!(out.details["outputAmount"], "4");
            assert_eq!(out.details["otherAmount"], "0.005");
        }
    }
}
