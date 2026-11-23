//! Provider-model pricing and exact per-attempt cost calculation.

pub mod fx;

use std::str::FromStr;

use anyhow::{Result, ensure};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgPool;

use crate::models::RequestLogRecord;

/// The current price schedule for one provider-scoped model.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceSchedule {
    /// Provider identity.
    pub provider_id: String,
    /// Provider-scoped model identity.
    pub model_id: String,
    /// ISO 4217 currency code.
    pub currency: String,
    /// Optional pricing source.
    pub source: String,
    /// Inclusive maximum prompt size, or no configured limit.
    #[serde(default)]
    pub max_input_tokens: Option<i64>,
    /// Price tiers ordered by their inclusive minimum input token count.
    pub tiers: Vec<PriceTier>,
}

/// The price captured before an upstream attempt starts.
#[derive(Debug, Clone)]
pub enum PriceSnapshot {
    /// A valid price schedule was available.
    Available(PriceSchedule),
    /// No price is configured for this model.
    Missing,
    /// The price could not be read from PostgreSQL.
    Unavailable,
}

/// Billing context held for the lifetime of one upstream attempt.
#[derive(Debug, Clone)]
pub struct AttemptBilling {
    /// The provider-model price at the start of this attempt.
    pub price: PriceSnapshot,
    /// Whether the outbound model matches the selected catalog model.
    pub target_matches: bool,
}

/// One prompt-size tier, with prices per million tokens.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceTier {
    /// Inclusive lower bound; the next tier supplies the exclusive upper bound.
    pub min_input_tokens: i64,
    /// Uncached input price in the schedule currency.
    pub input_price: String,
    /// Output price in the schedule currency.
    pub output_price: String,
    /// Optional cache-read price; absent means reads use the input price.
    pub cache_read_price: Option<String>,
    /// Cache write pricing method.
    pub cache_write_mode: CacheWriteMode,
    /// Cache-write price when separately charged.
    pub cache_write_price: Option<String>,
}

/// How cache-write tokens are billed by a particular schedule.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CacheWriteMode {
    /// Cache writes are charged at the normal input rate.
    Input,
    /// Cache writes have one separate per-token rate.
    Separate,
    /// The pricing cannot be represented by one cache-write rate.
    Unsupported,
}

/// Presence-preserving usage from the documented Chat Completions fields.
#[derive(Debug, Clone, Default)]
pub struct BillingUsage {
    /// Prompt token count.
    pub prompt: Option<i64>,
    /// Completion token count.
    pub completion: Option<i64>,
    /// Cache-read token count.
    pub cache_read: Option<i64>,
    /// Cache-write token count.
    pub cache_write: Option<i64>,
    /// Actual non-standard service tier when supplied by the response.
    pub service_tier: Option<String>,
    /// Audio usage needs pricing beyond the text-only price schedule.
    pub has_audio: bool,
    /// An optional counter was present but not a valid integer.
    pub invalid_details: bool,
}

/// Returns an optional count while preserving malformed present values as invalid.
fn optional_count(value: Option<&Value>) -> (Option<i64>, bool) {
    match value {
        None => (None, false),
        Some(value) => match value.as_i64() {
            Some(count) => (Some(count), false),
            None => (None, true),
        },
    }
}

impl BillingUsage {
    /// Extracts only documented Chat Completions usage fields, preserving missing values.
    #[must_use]
    pub fn from_response(response: &Value) -> Option<Self> {
        let usage = response.get("usage")?.as_object()?;
        let details = usage.get("prompt_tokens_details");
        let (cache_read, invalid_read) =
            optional_count(details.and_then(|value| value.get("cached_tokens")));
        let (cache_write, invalid_write) =
            optional_count(details.and_then(|value| value.get("cache_write_tokens")));
        Some(Self {
            prompt: usage.get("prompt_tokens").and_then(Value::as_i64),
            completion: usage.get("completion_tokens").and_then(Value::as_i64),
            cache_read,
            cache_write,
            service_tier: response
                .get("service_tier")
                .and_then(Value::as_str)
                .map(str::to_owned),
            has_audio: [
                usage.get("prompt_tokens_details"),
                usage.get("completion_tokens_details"),
            ]
            .into_iter()
            .flatten()
            .any(|detail| {
                detail
                    .get("audio_tokens")
                    .and_then(Value::as_i64)
                    .is_some_and(|count| count != 0)
            }),
            invalid_details: invalid_read
                || invalid_write
                || details.is_some_and(|value| !value.is_object()),
        })
    }
}

/// The persisted cost or a non-priced status.
#[derive(Debug, Clone)]
pub struct BillingResult {
    /// Exact original-currency total.
    pub amount: Option<Decimal>,
    /// Original currency.
    pub currency: Option<String>,
    /// Stable pricing status.
    pub status: &'static str,
    /// Immutable calculation snapshot.
    pub details: Value,
}

impl BillingResult {
    /// Creates an explicit non-priced result.
    fn unavailable(status: &'static str) -> Self {
        Self {
            amount: None,
            currency: None,
            status,
            details: json!({}),
        }
    }
}

/// Parses a bounded non-negative decimal price without floating-point conversion.
fn price(value: &str) -> Result<Decimal> {
    ensure!(value.len() <= 32, "price is too long");
    let parsed = Decimal::from_str(value)?;
    ensure!(parsed >= Decimal::ZERO, "price cannot be negative");
    ensure!(parsed.scale() <= 6, "price exceeds 6 decimal places");
    ensure!(parsed <= Decimal::from(1_000_000_u64), "price is too large");
    Ok(parsed)
}

impl PriceSchedule {
    /// Validates identities, currency, tier ordering and all prices.
    ///
    /// # Errors
    /// Returns an error when the schedule cannot be used safely.
    pub fn validate(&self) -> Result<()> {
        ensure!(
            !self.provider_id.trim().is_empty() && self.provider_id.len() <= 128,
            "invalid provider"
        );
        ensure!(
            !self.model_id.trim().is_empty()
                && self.model_id.len() <= 256
                && !self.model_id.contains('\0'),
            "invalid model"
        );
        ensure!(
            self.currency.len() == 3 && self.currency.bytes().all(|b| b.is_ascii_uppercase()),
            "invalid currency"
        );
        ensure!(self.source.len() <= 500, "source is too long");
        ensure!(
            !self.tiers.is_empty() && self.tiers.len() <= 100,
            "invalid tier count"
        );
        ensure!(
            self.tiers[0].min_input_tokens == 0,
            "first tier must start at zero"
        );
        let mut previous = -1;
        for tier in &self.tiers {
            ensure!(
                tier.min_input_tokens > previous,
                "tier boundaries must increase"
            );
            previous = tier.min_input_tokens;
            price(&tier.input_price)?;
            price(&tier.output_price)?;
            if let Some(read) = &tier.cache_read_price {
                price(read)?;
            }
            if let Some(write) = &tier.cache_write_price {
                price(write)?;
            }
            ensure!(
                tier.cache_write_mode != CacheWriteMode::Separate
                    || tier.cache_write_price.is_some(),
                "separate cache-write price is required"
            );
        }
        ensure!(
            self.max_input_tokens.is_none_or(|max| max >= previous),
            "maximum input tokens precedes the last tier"
        );
        Ok(())
    }
}

/// Calculates one attempt using its captured price and complete usage.
#[must_use]
#[allow(clippy::too_many_lines)]
pub fn calculate(
    schedule: Option<&PriceSchedule>,
    usage: Option<&BillingUsage>,
    target_matches: bool,
) -> BillingResult {
    if !target_matches {
        return BillingResult::unavailable("target_changed");
    }
    let Some(usage) = usage else {
        return BillingResult::unavailable("missing_usage");
    };
    let Some(schedule) = schedule else {
        return BillingResult::unavailable("missing_price");
    };
    if usage.invalid_details {
        return BillingResult::unavailable("invalid_usage");
    }
    if schedule.validate().is_err() {
        return BillingResult::unavailable("invalid_price");
    }
    if usage.has_audio
        || usage
            .service_tier
            .as_deref()
            .is_some_and(|tier| tier != "default")
    {
        return BillingResult::unavailable("unsupported_price");
    }
    let (Some(prompt), Some(output)) = (usage.prompt, usage.completion) else {
        return BillingResult::unavailable("missing_usage");
    };
    if prompt < 0 || output < 0 {
        return BillingResult::unavailable("invalid_usage");
    }
    if schedule.max_input_tokens.is_some_and(|max| prompt > max) {
        return BillingResult::unavailable("unsupported_price");
    }
    let Some(tier) = schedule
        .tiers
        .iter()
        .rev()
        .find(|tier| tier.min_input_tokens <= prompt)
    else {
        return BillingResult::unavailable("invalid_price");
    };
    let read = match usage.cache_read {
        Some(value) => value,
        None if tier.cache_read_price.is_none() => 0,
        None if tier
            .cache_read_price
            .as_deref()
            .and_then(|value| price(value).ok())
            == price(&tier.input_price).ok() =>
        {
            0
        }
        None => return BillingResult::unavailable("missing_usage"),
    };
    if read < 0 || read > prompt {
        return BillingResult::unavailable("invalid_usage");
    }
    let write = match (tier.cache_write_mode, usage.cache_write) {
        (CacheWriteMode::Input, None) => 0,
        (CacheWriteMode::Separate, None)
            if tier
                .cache_write_price
                .as_deref()
                .and_then(|value| price(value).ok())
                == Some(Decimal::ZERO) =>
        {
            0
        }
        (_, Some(value)) if value >= 0 => value,
        (_, Some(_)) => return BillingResult::unavailable("invalid_usage"),
        _ => return BillingResult::unavailable("missing_usage"),
    };
    if read.checked_add(write).is_none_or(|sum| sum > prompt) {
        return BillingResult::unavailable("invalid_usage");
    }
    if tier.cache_write_mode == CacheWriteMode::Unsupported && write > 0 {
        return BillingResult::unavailable("unsupported_price");
    }
    let input_tokens = prompt - read - write;
    let prices = (price(&tier.input_price), price(&tier.output_price));
    let (Ok(input_price), Ok(output_price)) = prices else {
        return BillingResult::unavailable("invalid_price");
    };
    let read_price = tier
        .cache_read_price
        .as_deref()
        .map_or(Some(input_price), |value| price(value).ok());
    let Some(read_price) = read_price else {
        return BillingResult::unavailable("invalid_price");
    };
    let write_price = match tier.cache_write_mode {
        CacheWriteMode::Input | CacheWriteMode::Unsupported => Some(input_price),
        CacheWriteMode::Separate => tier
            .cache_write_price
            .as_deref()
            .and_then(|value| price(value).ok()),
    };
    let Some(write_price) = write_price else {
        return BillingResult::unavailable("missing_price");
    };
    let million = Decimal::from(1_000_000_u64);
    let component = |tokens, rate| {
        Decimal::from(tokens)
            .checked_mul(rate)
            .and_then(|value| value.checked_div(million))
    };
    let (Some(input_cost), Some(output_cost), Some(read_cost), Some(write_cost)) = (
        component(input_tokens, input_price),
        component(output, output_price),
        component(read, read_price),
        component(write, write_price),
    ) else {
        return BillingResult::unavailable("invalid_usage");
    };
    let Some(amount) = input_cost
        .checked_add(output_cost)
        .and_then(|value| value.checked_add(read_cost))
        .and_then(|value| value.checked_add(write_cost))
    else {
        return BillingResult::unavailable("invalid_usage");
    };
    BillingResult {
        amount: Some(amount),
        currency: Some(schedule.currency.clone()),
        status: if tier.cache_write_mode == CacheWriteMode::Separate && usage.cache_write.is_none()
        {
            "estimated"
        } else {
            "priced"
        },
        details: json!({
            "tier": tier, "promptTokens": prompt, "inputTokens": input_tokens,
            "outputTokens": output, "cacheReadTokens": usage.cache_read, "cacheWriteTokens": usage.cache_write,
            "source": schedule.source, "assumedMissingWriteZero": tier.cache_write_mode == CacheWriteMode::Separate && usage.cache_write.is_none(),
            "inputAmount": input_cost.to_string(), "outputAmount": output_cost.to_string(),
            "cacheReadAmount": read_cost.to_string(), "cacheWriteAmount": write_cost.to_string()
        }),
    }
}

/// Reads one current price without holding a transaction during the upstream request.
///
/// # Errors
/// Returns an error if the stored price data or database cannot be read.
pub async fn load_price(
    pool: &PgPool,
    provider_id: &str,
    model_id: &str,
) -> Result<Option<PriceSchedule>> {
    let raw: Option<Value> = sqlx::query_scalar(
        "SELECT item FROM catalog_state, jsonb_array_elements(coalesce(billing_prices, '[]'::jsonb)) item \
         WHERE singleton AND item->>'providerId'=$1 AND item->>'modelId'=$2 LIMIT 1",
    ).bind(provider_id).bind(model_id).fetch_optional(pool).await?;
    raw.map(serde_json::from_value)
        .transpose()
        .map_err(Into::into)
}

/// Calculates the cost without rereading prices that may have changed in flight.
#[must_use]
pub fn calculate_for_record(rec: &RequestLogRecord) -> BillingResult {
    match &rec.billing.price {
        PriceSnapshot::Unavailable if rec.billing.target_matches => {
            BillingResult::unavailable("pricing_error")
        }
        PriceSnapshot::Available(schedule) => calculate(
            Some(schedule),
            rec.billing_usage.as_ref(),
            rec.billing.target_matches,
        ),
        PriceSnapshot::Missing | PriceSnapshot::Unavailable => {
            calculate(None, rec.billing_usage.as_ref(), rec.billing.target_matches)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schedule() -> PriceSchedule {
        PriceSchedule {
            provider_id: "provider".into(),
            model_id: "model".into(),
            currency: "USD".into(),
            source: String::new(),
            max_input_tokens: None,
            tiers: vec![
                PriceTier {
                    min_input_tokens: 0,
                    input_price: "1".into(),
                    output_price: "4".into(),
                    cache_read_price: Some("0.25".into()),
                    cache_write_mode: CacheWriteMode::Separate,
                    cache_write_price: Some("1.25".into()),
                },
                PriceTier {
                    min_input_tokens: 32_000,
                    input_price: "2".into(),
                    output_price: "8".into(),
                    cache_read_price: Some("0.5".into()),
                    cache_write_mode: CacheWriteMode::Separate,
                    cache_write_price: Some("2.5".into()),
                },
            ],
        }
    }

    #[test]
    fn uses_entire_matching_tier_without_double_counting_cache() {
        let usage = BillingUsage {
            prompt: Some(40_000),
            completion: Some(2_000),
            cache_read: Some(30_000),
            cache_write: Some(2_000),
            ..BillingUsage::default()
        };
        let result = calculate(Some(&schedule()), Some(&usage), true);
        assert_eq!(result.status, "priced");
        assert_eq!(result.amount, Decimal::from_str("0.052").ok());
        assert_eq!(result.details["inputTokens"], 8_000);
    }

    #[test]
    fn unknown_and_invalid_usage_are_not_free() {
        let mut usage = BillingUsage {
            prompt: Some(100),
            completion: Some(10),
            cache_read: None,
            cache_write: Some(0),
            ..BillingUsage::default()
        };
        assert_eq!(
            calculate(Some(&schedule()), Some(&usage), true).status,
            "missing_usage"
        );
        usage.cache_read = Some(101);
        assert_eq!(
            calculate(Some(&schedule()), Some(&usage), true).status,
            "invalid_usage"
        );
        assert_eq!(calculate(None, Some(&usage), true).status, "missing_price");
        assert_eq!(
            calculate(Some(&schedule()), Some(&usage), false).status,
            "target_changed"
        );
    }

    #[test]
    fn normal_input_mode_does_not_require_or_double_charge_writes() {
        let mut price = schedule();
        price.tiers[0].cache_write_mode = CacheWriteMode::Input;
        let mut usage = BillingUsage {
            prompt: Some(100),
            completion: Some(0),
            cache_read: Some(20),
            cache_write: None,
            ..BillingUsage::default()
        };
        let without_breakdown = calculate(Some(&price), Some(&usage), true);
        usage.cache_write = Some(30);
        let with_breakdown = calculate(Some(&price), Some(&usage), true);
        assert_eq!(without_breakdown.amount, with_breakdown.amount);
        assert_eq!(with_breakdown.amount, Decimal::from_str("0.000085").ok());
    }

    #[test]
    fn missing_cache_details_are_safe_only_when_read_and_write_use_input_price() {
        let mut price = schedule();
        price.tiers[0].cache_read_price = None;
        price.tiers[0].cache_write_mode = CacheWriteMode::Input;
        let usage = BillingUsage {
            prompt: Some(100),
            completion: Some(0),
            ..BillingUsage::default()
        };
        assert_eq!(
            calculate(Some(&price), Some(&usage), true).amount,
            Decimal::from_str("0.0001").ok()
        );
        price.tiers[0].cache_read_price = Some("0".into());
        assert_eq!(
            calculate(Some(&price), Some(&usage), true).status,
            "missing_usage"
        );
        price.tiers[0].cache_read_price = None;
        let malformed = BillingUsage::from_response(
            &json!({"usage":{"prompt_tokens":100,"completion_tokens":0,"prompt_tokens_details":{"cached_tokens":"invalid"}}}),
        );
        assert!(malformed.is_some_and(
            |usage| calculate(Some(&price), Some(&usage), true).status == "invalid_usage"
        ));
    }

    #[test]
    fn standard_usage_parser_preserves_missing_write_and_read_fields() {
        let response = json!({"usage":{"prompt_tokens":100,"completion_tokens":10,
            "prompt_tokens_details":{"cached_tokens":40,"cache_write_tokens":20}}});
        let usage = BillingUsage::from_response(&response);
        assert!(usage.is_some());
        let usage = usage.unwrap_or_default();
        assert_eq!(usage.cache_read, Some(40));
        assert_eq!(usage.cache_write, Some(20));
        let partial = BillingUsage::from_response(
            &json!({"usage":{"prompt_tokens":100,"completion_tokens":10}}),
        );
        assert!(
            partial.is_some_and(|usage| usage.cache_read.is_none() && usage.cache_write.is_none())
        );
    }

    #[test]
    fn zero_write_rate_estimates_missing_write_usage_and_respects_maximum() {
        let mut schedule = schedule();
        schedule.tiers[0].cache_write_price = Some("0".into());
        schedule.max_input_tokens = Some(32_000);
        let mut usage = BillingUsage {
            prompt: Some(100),
            completion: Some(10),
            cache_read: Some(20),
            cache_write: None,
            ..BillingUsage::default()
        };
        let estimated = calculate(Some(&schedule), Some(&usage), true);
        assert_eq!(estimated.status, "estimated");
        assert_eq!(estimated.details["assumedMissingWriteZero"], true);
        assert_eq!(estimated.amount, Decimal::from_str("0.000125").ok());
        usage.cache_write = Some(30);
        let known = calculate(Some(&schedule), Some(&usage), true);
        assert_eq!(known.status, "priced");
        assert_eq!(known.amount, Decimal::from_str("0.000095").ok());
        usage.prompt = Some(32_001);
        assert_eq!(
            calculate(Some(&schedule), Some(&usage), true).status,
            "unsupported_price"
        );
    }

    #[test]
    fn equal_read_and_input_rates_allow_missing_read_count() {
        let mut schedule = schedule();
        schedule.tiers[0].input_price = "0".into();
        schedule.tiers[0].cache_read_price = Some("0".into());
        schedule.tiers[0].cache_write_price = Some("0".into());
        let usage = BillingUsage {
            prompt: Some(100),
            completion: Some(0),
            ..BillingUsage::default()
        };
        let result = calculate(Some(&schedule), Some(&usage), true);
        assert_eq!(result.status, "estimated");
        assert_eq!(result.amount, Some(Decimal::ZERO));
    }
}
