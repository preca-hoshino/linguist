//! Script-driven per-attempt billing evaluation and secret scrubbing.

pub mod fx;

use rust_decimal::Decimal;
use serde_json::{Value, json};
use tracing::warn;

use crate::models::RequestLogRecord;
use crate::script_engine::ScriptEngine;
use crate::script_engine::runtime::{BillingInput, BillingTimings, BillingTokens, UsageOverride};

/// The persisted cost or non-priced status for one upstream attempt.
#[derive(Debug, Clone)]
pub struct BillingResult {
    /// Exact original-currency total.
    pub amount: Option<Decimal>,
    /// Original 3-letter currency code.
    pub currency: Option<String>,
    /// Stable pricing status (`"priced"`, `"estimated"`, `"free"`, `"unpriced"`, `"unbilled_error"`, `"script_error"`).
    pub status: String,
    /// Structured calculation snapshot (`items`, `meta`, and 5 bucket totals).
    pub details: Value,
}

impl BillingResult {
    /// Creates a non-priced result with empty details.
    #[must_use]
    pub fn unavailable(status: &str) -> Self {
        Self {
            amount: None,
            currency: None,
            status: status.to_string(),
            details: json!({}),
        }
    }
}

/// Evaluates the `Provider` -> `Model` `onBilling` script chain for a completed request record,
/// applies optional `usageOverrides`, and scrubs any leaked provider `apiKey` from log fields.
#[allow(clippy::too_many_lines)]
pub async fn evaluate_record_billing(
    engine: &ScriptEngine,
    rec: &mut RequestLogRecord,
) -> BillingResult {
    let snapshot = rec.catalog_snapshot.clone();
    let provider_and_model = snapshot
        .as_ref()
        .and_then(|cat| cat.find_model(&rec.provider_id, &rec.model_id));

    let provider_api_key = provider_and_model.map_or("", |(p, _)| p.api_key.as_str());

    let result = if rec.status_code >= 400 && rec.raw_usage.is_none() {
        BillingResult::unavailable("unbilled_error")
    } else if let Some((provider, model)) = provider_and_model {
        let mut units = Vec::new();
        for u in &provider.compiled.units {
            if u.has_on_billing {
                units.push(u.clone());
            }
        }
        for u in &model.compiled.units {
            if u.has_on_billing {
                units.push(u.clone());
            }
        }

        if units.is_empty() {
            BillingResult::unavailable("unpriced")
        } else {
            let input = BillingInput {
                request_started_at_utc: rec.started_at.to_rfc3339(),
                completed_at_utc: rec.created_at.to_rfc3339(),
                attempt: rec.attempt_index,
                status_code: rec.status_code,
                is_stream: rec.is_stream,
                interrupted: rec.interrupted,
                project: snapshot
                    .as_ref()
                    .and_then(|c| c.find_project(&rec.project_id))
                    .map_or_else(
                        || fallback_entity(&rec.project_id, &rec.project_name),
                        crate::models::ProjectConfig::to_entity_info,
                    ),
                call_model: snapshot
                    .as_ref()
                    .and_then(|c| {
                        c.resolve_project_and_call_model(&rec.project_id, &rec.call_model_id)
                    })
                    .map_or_else(
                        || fallback_entity(&rec.call_model_id, &rec.call_model_name),
                        |(_, cm)| cm.to_entity_info(),
                    ),
                provider: provider.to_provider_info(),
                model: model.to_entity_info(),
                state: rec.script_state.clone(),
                timings: BillingTimings {
                    ttft_ms: rec.ttft_ms,
                    total_duration_ms: rec.total_duration_ms,
                    generation_duration_ms: rec.generation_duration_ms,
                    decode_tps: rec.decode_tps,
                },
                tokens: BillingTokens {
                    input: rec.input_tokens,
                    output: rec.output_tokens,
                    cache_read: rec.cache_read_tokens,
                    cache_creation: rec.cache_creation_tokens,
                    reasoning: rec.reasoning_tokens,
                    total: rec.total_tokens,
                    extra: rec.extra_tokens.clone(),
                    source: rec.token_source.clone(),
                },
                raw_usage: rec.raw_usage.clone(),
            };

            match engine.execute_billing_chain(&units, &input).await {
                Ok(out) => {
                    if let Some(ov) = out.usage_override {
                        apply_usage_override(rec, ov);
                    }
                    BillingResult {
                        amount: out.amount,
                        currency: out.currency,
                        status: out.status,
                        details: out.details,
                    }
                }
                Err(err) => {
                    warn!(
                        request_uid = %rec.request_uid,
                        provider = %rec.provider_id,
                        model = %rec.model_id,
                        error = %err,
                        "onBilling script failed"
                    );
                    BillingResult {
                        amount: None,
                        currency: None,
                        status: "script_error".to_string(),
                        details: json!({ "error": err.to_string() }),
                    }
                }
            }
        }
    } else {
        BillingResult::unavailable("unpriced")
    };

    let mut result = result;
    if !provider_api_key.trim().is_empty() && provider_api_key.len() >= 6 {
        scrub_secret_in_value(&mut rec.script_state, provider_api_key);
        if let Some(headers) = &mut rec.request_headers {
            scrub_secret_in_value(headers, provider_api_key);
        }
        if let Some(msg) = &mut rec.error_message {
            *msg = msg.replace(provider_api_key, "***REDACTED***");
        }
        scrub_secret_in_value(&mut result.details, provider_api_key);
    }

    result
}

/// Applies script-supplied `overrideUsage` patches and recalculates derived totals and TPS.
fn apply_usage_override(rec: &mut RequestLogRecord, ov: UsageOverride) {
    if let Some(v) = ov.input_tokens {
        rec.input_tokens = v.max(0);
    }
    if let Some(v) = ov.output_tokens {
        let clamped = v.max(0);
        rec.output_tokens = clamped;
        #[allow(clippy::cast_precision_loss)]
        {
            rec.decode_tps = if rec.generation_duration_ms > 0.1 && clamped > 0 {
                (clamped as f64) / (rec.generation_duration_ms / 1000.0)
            } else {
                0.0
            };
            rec.e2e_tps = if rec.total_duration_ms > 0.1 && clamped > 0 {
                (clamped as f64) / (rec.total_duration_ms / 1000.0)
            } else {
                0.0
            };
        }
    }
    if let Some(v) = ov.cache_read_tokens {
        rec.cache_read_tokens = v.max(0);
    }
    if let Some(v) = ov.cache_creation_tokens {
        rec.cache_creation_tokens = v.max(0);
    }
    if let Some(v) = ov.reasoning_tokens {
        rec.reasoning_tokens = v.max(0);
    }
    if let Some(extra) = ov.extra_tokens {
        for (k, v) in extra {
            if v >= 0 {
                rec.extra_tokens.insert(k, v);
            }
        }
    }
    rec.total_tokens = rec.input_tokens.saturating_add(rec.output_tokens);
}

/// Recursively replaces any occurrences of `secret` inside JSON strings with `***REDACTED***`.
pub fn scrub_secret_in_value(val: &mut Value, secret: &str) {
    match val {
        Value::String(s) => {
            if s.contains(secret) {
                *s = s.replace(secret, "***REDACTED***");
            }
        }
        Value::Array(arr) => {
            for item in arr {
                scrub_secret_in_value(item, secret);
            }
        }
        Value::Object(map) => {
            for item in map.values_mut() {
                scrub_secret_in_value(item, secret);
            }
        }
        _ => {}
    }
}

/// Builds a minimal `EntityInfo` fallback when a snapshot entity is missing.
fn fallback_entity(id: &str, name: &str) -> crate::models::EntityInfo {
    crate::models::EntityInfo {
        id: id.to_string(),
        name: name.to_string(),
        icon: String::new(),
        tags: Vec::new(),
        meta: serde_json::Map::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_scrubber_redacts_nested_strings() {
        let mut val = json!({
            "auth": "Bearer sk-super-secret-123",
            "nested": ["ok", { "err": "failed with sk-super-secret-123" }]
        });
        scrub_secret_in_value(&mut val, "sk-super-secret-123");
        let serialized = val.to_string();
        assert!(!serialized.contains("sk-super-secret-123"));
        assert!(serialized.contains("***REDACTED***"));
    }
}
