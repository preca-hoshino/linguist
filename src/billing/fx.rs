//! Background exchange-rate refresh with a shared PostgreSQL snapshot.

use std::collections::{BTreeMap, BTreeSet};
use std::str::FromStr;
use std::time::Duration;

use anyhow::{Context, Result, ensure};
use chrono::{DateTime, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::PgPool;
use tracing::warn;

use super::PriceSchedule;
use crate::state::AppState;

/// One reference exchange rate, in units of quote currency per base unit.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rate {
    /// Base currency.
    pub base: String,
    /// Quote currency.
    pub quote: String,
    /// Published observation date.
    pub date: NaiveDate,
    /// Exact decimal exchange rate.
    pub rate: String,
    /// Time this pair was successfully retrieved.
    pub fetched_at: DateTime<Utc>,
}

/// Most recently retrieved rates for one display currency.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateSnapshot {
    /// Target display currency.
    pub target: String,
    /// UTC retrieval time.
    pub fetched_at: DateTime<Utc>,
    /// Successful currency-pair results.
    pub rates: Vec<Rate>,
}

impl RateSnapshot {
    /// Finds a usable, non-stale rate for a currency.
    #[must_use]
    pub fn rate_for(&self, base: &str, target: &str) -> Option<Decimal> {
        if base == target {
            return Some(Decimal::ONE);
        }
        if self.target != target
            || Utc::now()
                .signed_duration_since(self.fetched_at)
                .num_hours()
                > 72
        {
            return None;
        }
        self.rates
            .iter()
            .find(|rate| {
                rate.base == base
                    && rate.quote == target
                    && Utc::now()
                        .signed_duration_since(rate.fetched_at)
                        .num_hours()
                        <= 72
                    && Utc::now()
                        .date_naive()
                        .signed_duration_since(rate.date)
                        .num_days()
                        <= 7
            })
            .and_then(|rate| Decimal::from_str(&rate.rate).ok())
            .filter(|rate| *rate > Decimal::ZERO)
    }
}

/// Starts an isolated periodic refresh when a display currency is configured.
pub fn start(state: &AppState) {
    let Some(target) = state.config.billing.display_currency.clone() else {
        return;
    };
    let Some(pool) = state.db_pool.clone() else {
        return;
    };
    if target.len() != 3 || !target.bytes().all(|byte| byte.is_ascii_uppercase()) {
        warn!("invalid billing display currency; FX refresh disabled");
        return;
    }

    let client = state.http_client.clone();
    tokio::spawn(async move {
        loop {
            if let Err(error) = refresh(&pool, &client, &target).await {
                warn!(%error, "failed to refresh billing reference rates");
            }

            tokio::time::sleep(Duration::from_hours(6)).await;
        }
    });
}

/// Refreshes reference rates after saving a price, without delaying the response.
pub fn refresh_after_price_change(state: &AppState) {
    let Some(target) = state.config.billing.display_currency.clone() else {
        return;
    };
    if target.len() != 3 || !target.bytes().all(|byte| byte.is_ascii_uppercase()) {
        return;
    }
    let Some(pool) = state.db_pool.clone() else {
        return;
    };
    let client = state.http_client.clone();
    tokio::spawn(async move {
        if let Err(error) = refresh(&pool, &client, &target).await {
            warn!(%error, "failed to refresh billing reference rates after price change");
        }
    });
}

/// Refreshes all currencies used by current prices or existing billing rows.
async fn refresh(pool: &PgPool, client: &reqwest::Client, target: &str) -> Result<()> {
    let prices: Option<Value> =
        sqlx::query_scalar("SELECT billing_prices FROM catalog_state WHERE singleton")
            .fetch_one(pool)
            .await?;
    let schedules: Vec<PriceSchedule> = prices
        .map(serde_json::from_value)
        .transpose()?
        .unwrap_or_default();
    let mut bases: BTreeSet<String> = schedules
        .into_iter()
        .map(|version| version.currency)
        .collect();
    let used: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT billing_currency FROM request_logs WHERE billing_currency IS NOT NULL",
    )
    .fetch_all(pool)
    .await?;
    bases.extend(used);
    bases.remove(target);
    let previous: Option<Value> =
        sqlx::query_scalar("SELECT billing_fx_rates FROM catalog_state WHERE singleton")
            .fetch_one(pool)
            .await?;
    let previous: Option<RateSnapshot> = previous.map(serde_json::from_value).transpose()?;
    let mut rates = Vec::new();
    for base in bases {
        if base.len() != 3 || !base.bytes().all(|byte| byte.is_ascii_uppercase()) {
            warn!(currency = %base, "ignoring invalid currency in billing data");
            continue;
        }
        match fetch_rate(client, &base, target).await {
            Ok(rate) => rates.push(rate),
            Err(error) => {
                warn!(%base, %error, "failed to refresh currency pair");
                if let Some(rate) = previous.as_ref().and_then(|snapshot| {
                    snapshot
                        .rates
                        .iter()
                        .find(|rate| rate.base == base && rate.quote == target)
                }) {
                    rates.push(rate.clone());
                }
            }
        }
    }
    let snapshot = RateSnapshot {
        target: target.to_owned(),
        fetched_at: Utc::now(),
        rates,
    };
    let mut tx = pool.begin().await?;
    let latest: Option<Value> =
        sqlx::query_scalar("SELECT billing_fx_rates FROM catalog_state WHERE singleton FOR UPDATE")
            .fetch_one(&mut *tx)
            .await?;
    let latest: Option<RateSnapshot> = latest.map(serde_json::from_value).transpose()?;
    let mut merged = snapshot;
    if let Some(existing) = latest.filter(|existing| existing.target == target) {
        for rate in existing.rates {
            if let Some(current) = merged
                .rates
                .iter_mut()
                .find(|current| current.base == rate.base && current.quote == rate.quote)
            {
                if rate.fetched_at > current.fetched_at {
                    *current = rate;
                }
            } else {
                merged.rates.push(rate);
            }
        }
    }
    sqlx::query("UPDATE catalog_state SET billing_fx_rates = $1 WHERE singleton")
        .bind(serde_json::to_value(merged)?)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// Fetches and validates one currency pair.
async fn fetch_rate(client: &reqwest::Client, base: &str, target: &str) -> Result<Rate> {
    let response: Value = client
        .get("https://api.frankfurter.dev/v2/rates")
        .query(&[("base", base), ("quotes", target)])
        .timeout(Duration::from_secs(10))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let item = response
        .as_array()
        .and_then(|items| items.first())
        .context("missing exchange rate")?;
    ensure!(
        item.get("base").and_then(Value::as_str) == Some(base),
        "unexpected rate base"
    );
    ensure!(
        item.get("quote").and_then(Value::as_str) == Some(target),
        "unexpected rate quote"
    );
    let rate = item
        .get("rate")
        .and_then(Value::as_number)
        .context("missing rate")?
        .to_string();
    ensure!(
        Decimal::from_str(&rate)? > Decimal::ZERO,
        "invalid exchange rate"
    );
    let date = NaiveDate::parse_from_str(
        item.get("date")
            .and_then(Value::as_str)
            .context("missing rate date")?,
        "%Y-%m-%d",
    )?;
    Ok(Rate {
        base: base.to_owned(),
        quote: target.to_owned(),
        date,
        rate,
        fetched_at: Utc::now(),
    })
}

/// Converts an entire set of original-currency totals, refusing partial totals.
#[must_use]
pub fn convert_totals(
    totals: &BTreeMap<String, Decimal>,
    target: &str,
    snapshot: Option<&RateSnapshot>,
) -> Option<Decimal> {
    totals
        .iter()
        .try_fold(Decimal::ZERO, |sum, (currency, amount)| {
            let rate = if currency == target {
                Some(Decimal::ONE)
            } else {
                snapshot.and_then(|snapshot| snapshot.rate_for(currency, target))
            }?;
            sum.checked_add(amount.checked_mul(rate)?)
        })
}
