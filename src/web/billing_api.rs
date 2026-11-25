//! Price publication and expense reporting endpoints.

use std::collections::BTreeMap;
use std::str::FromStr;

use axum::extract::{Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Duration, FixedOffset, NaiveDate, Utc};
use rust_decimal::Decimal;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{PgPool, Row, postgres::PgRow};
use uuid::Uuid;

use crate::billing::fx::{RateSnapshot, convert_totals};
use crate::state::AppState;

/// Registers billing endpoints (all protected by the admin session middleware).
pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/billing/fx", get(exchange_rate))
        .route("/api/v1/billing/report", get(report))
        .route("/api/v1/billing/attempts", get(attempts))
}

/// Registers dashboard billing endpoints under `/api/v1/stats/*` (protected by admin session).
pub(super) fn stats_router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/stats/billing", post(dashboard))
        .route("/api/v1/stats/billing/attempts", get(attempts))
}

/// Source currency for a reference rate.
#[derive(Debug, Deserialize)]
struct FxQuery {
    /// Original currency of the model price.
    currency: String,
}

/// Returns the cached reference rate without contacting the provider in the request path.
async fn exchange_rate(State(state): State<AppState>, Query(query): Query<FxQuery>) -> Response {
    if query.currency.len() != 3 || !query.currency.bytes().all(|byte| byte.is_ascii_uppercase()) {
        return fail(StatusCode::BAD_REQUEST, "invalid_query");
    }
    let Some(target) = state.config.billing.display_currency.as_deref() else {
        return Json(json!({ "target": null, "rate": null })).into_response();
    };
    let Some(pool) = state.db_pool.as_ref() else {
        return fail(StatusCode::SERVICE_UNAVAILABLE, "billing_unavailable");
    };
    let raw: Option<Value> =
        match sqlx::query_scalar("SELECT billing_fx_rates FROM catalog_state WHERE singleton")
            .fetch_one(pool)
            .await
        {
            Ok(value) => value,
            Err(error) => return database_error(&error.into()),
        };
    let snapshot: Option<RateSnapshot> = match raw.map(serde_json::from_value).transpose() {
        Ok(value) => value,
        Err(error) => return database_error(&error.into()),
    };
    let rate = if query.currency == target {
        Some(Decimal::ONE)
    } else {
        snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.rate_for(&query.currency, target))
    };
    let date = snapshot
        .as_ref()
        .and_then(|snapshot| {
            snapshot
                .rates
                .iter()
                .find(|item| item.base == query.currency && item.quote == target)
        })
        .map(|item| item.date);
    Json(json!({"target":target,"rate":rate.map(|value| value.to_string()),"date":date}))
        .into_response()
}

/// Filters matching the telemetry overview and its visible request rows.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DashboardQuery {
    /// Optional project identity.
    project_id: Option<String>,
    /// Optional provider identity.
    provider_id: Option<String>,
    /// Identifiers of the visible recent attempts.
    request_uids: Vec<Uuid>,
}

/// Returns cost data for the existing public telemetry dashboard.
async fn dashboard(State(state): State<AppState>, Json(query): Json<DashboardQuery>) -> Response {
    if query.request_uids.len() > 50
        || [&query.project_id, &query.provider_id]
            .into_iter()
            .flatten()
            .any(|value| value.contains('\0') || value.len() > 128)
    {
        return fail(StatusCode::BAD_REQUEST, "invalid_query");
    }
    let Some(pool) = state.db_pool.as_ref() else {
        return fail(StatusCode::SERVICE_UNAVAILABLE, "billing_unavailable");
    };
    match build_dashboard(pool, &state, &query).await {
        Ok(result) => Json(result).into_response(),
        Err(error) => database_error(&error),
    }
}

/// Per-day original-currency amounts and count of unpriced attempts.
#[derive(Default)]
struct DashboardDay {
    /// Known amounts in their original currencies.
    amounts: BTreeMap<String, Decimal>,
    /// Attempts without a known amount.
    unpriced: i64,
}

/// Serializes original-currency amounts without floating-point conversion.
fn amount_list(amounts: &BTreeMap<String, Decimal>) -> Vec<Value> {
    amounts
        .iter()
        .map(|(currency, amount)| json!({"currency": currency, "amount": amount.to_string()}))
        .collect()
}

/// Reads cost totals and requested rows from a single database snapshot.
#[allow(clippy::too_many_lines)]
async fn build_dashboard(
    pool: &PgPool,
    state: &AppState,
    query: &DashboardQuery,
) -> Result<Value, anyhow::Error> {
    let offset = crate::db::timezone_offset_secs(&state.config.ui.timezone);
    let today = crate::db::local_stat_date(Utc::now(), offset);
    let start = (today - Duration::days(364))
        .and_hms_opt(0, 0, 0)
        .and_then(|date| {
            FixedOffset::east_opt(offset).and_then(|tz| date.and_local_timezone(tz).single())
        })
        .ok_or_else(|| anyhow::anyhow!("invalid statistics date or timezone"))?
        .to_utc();
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    let rows = sqlx::query(
        "SELECT (created_at AT TIME ZONE 'UTC' + make_interval(secs => $4::int))::date::text AS day, \
         billing_currency, sum(billing_amount)::text AS amount, \
         count(*) FILTER (WHERE billing_amount IS NULL) AS unpriced \
         FROM request_logs WHERE created_at >= $1 \
         AND ($2::text IS NULL OR project_id=$2) AND ($3::text IS NULL OR provider_id=$3) \
         GROUP BY day, billing_currency ORDER BY day, billing_currency",
    )
    .bind(start)
    .bind(&query.project_id)
    .bind(&query.provider_id)
    .bind(offset)
    .fetch_all(&mut *tx)
    .await?;
    let recent = sqlx::query(
        "SELECT request_uid, billing_currency, billing_amount::text AS amount, billing_status \
         FROM request_logs WHERE request_uid = ANY($1) \
         AND ($2::text IS NULL OR project_id=$2) AND ($3::text IS NULL OR provider_id=$3)",
    )
    .bind(&query.request_uids)
    .bind(&query.project_id)
    .bind(&query.provider_id)
    .fetch_all(&mut *tx)
    .await?;
    let raw: Option<Value> =
        sqlx::query_scalar("SELECT billing_fx_rates FROM catalog_state WHERE singleton")
            .fetch_one(&mut *tx)
            .await?;
    tx.commit().await?;
    let snapshot: Option<RateSnapshot> = raw.map(serde_json::from_value).transpose()?;
    let mut daily: BTreeMap<String, DashboardDay> = BTreeMap::new();
    let mut totals: BTreeMap<String, Decimal> = BTreeMap::new();
    let mut unpriced = 0_i64;
    for row in rows {
        let day = daily.entry(row.try_get("day")?).or_default();
        let count: i64 = row.try_get("unpriced")?;
        day.unpriced += count;
        unpriced += count;
        let currency: Option<String> = row.try_get("billing_currency")?;
        let amount: Option<String> = row.try_get("amount")?;
        if let Some(amount) = amount {
            let currency = currency.ok_or_else(|| anyhow::anyhow!("priced row has no currency"))?;
            let amount = Decimal::from_str(&amount)?;
            day.amounts.insert(currency.clone(), amount);
            let sum = totals.entry(currency).or_default();
            *sum = sum
                .checked_add(amount)
                .ok_or_else(|| anyhow::anyhow!("billing total overflow"))?;
        }
    }
    let display = state.config.billing.display_currency.as_deref();
    let converted = display
        .filter(|_| !totals.is_empty())
        .and_then(|currency| convert_totals(&totals, currency, snapshot.as_ref()));
    let wall_currency = if converted.is_some() {
        display
    } else if totals.len() == 1 {
        totals.keys().next().map(String::as_str)
    } else {
        None
    };
    let approximate =
        wall_currency.is_some_and(|currency| totals.keys().any(|base| base != currency));
    let days: Vec<Value> = daily
        .into_iter()
        .map(|(date, day)| {
            let amount = wall_currency
                .filter(|_| !day.amounts.is_empty())
                .and_then(|currency| convert_totals(&day.amounts, currency, snapshot.as_ref()));
            json!({"date": date, "totals": amount_list(&day.amounts), "unpriced": day.unpriced, "wallAmount": amount.map(|value| value.to_string())})
        })
        .collect();
    let items: Vec<Value> = recent
        .into_iter()
        .map(|row| {
            let currency: Option<String> = row.try_get("billing_currency")?;
            let amount: Option<String> = row.try_get("amount")?;
            let converted = match (&currency, &amount, display) {
                (Some(currency), Some(amount), Some(target)) => {
                    let values = BTreeMap::from([(currency.clone(), Decimal::from_str(amount)?)]);
                    convert_totals(&values, target, snapshot.as_ref())
                        .map(|value| value.to_string())
                }
                _ => None,
            };
            Ok(json!({
                "requestUid": row.try_get::<Uuid,_>("request_uid")?,
                "currency": currency, "amount": amount, "convertedAmount": converted,
                "billingStatus": row.try_get::<Option<String>,_>("billing_status")?
            }))
        })
        .collect::<Result<_, anyhow::Error>>()?;
    Ok(json!({
        "today": today, "totals": amount_list(&totals), "unpriced": unpriced, "days": days, "items": items,
        "displayCurrency": display, "convertedTotal": converted.map(|value| value.to_string()),
        "wallCurrency": wall_currency, "wallApproximate": approximate
    }))
}

/// Filters bounded expense reports.
#[derive(Debug, Deserialize)]
struct ReportQuery {
    /// Inclusive start date in the configured statistics timezone.
    from: NaiveDate,
    /// Inclusive end date in the configured statistics timezone.
    to: NaiveDate,
    /// Optional project identity.
    project_id: Option<String>,
    /// Optional provider identity.
    provider_id: Option<String>,
    /// Optional model identity.
    model_id: Option<String>,
    /// Page of recent attempts, one-based.
    page: Option<i64>,
}

/// Generates original-currency summaries and one page of attempts.
async fn report(State(state): State<AppState>, Query(query): Query<ReportQuery>) -> Response {
    if query.from > query.to
        || (query.to - query.from).num_days() >= 366
        || query
            .page
            .is_some_and(|page| !(1..=100_000).contains(&page))
    {
        return fail(StatusCode::BAD_REQUEST, "invalid_query");
    }
    let Some(pool) = state.db_pool.as_ref() else {
        return fail(StatusCode::SERVICE_UNAVAILABLE, "billing_unavailable");
    };
    let offset = crate::db::timezone_offset_secs(&state.config.ui.timezone);
    let bounds = FixedOffset::east_opt(offset).and_then(|timezone| {
        Some((
            query
                .from
                .and_hms_opt(0, 0, 0)?
                .and_local_timezone(timezone)
                .single()?
                .to_utc(),
            query
                .to
                .succ_opt()?
                .and_hms_opt(0, 0, 0)?
                .and_local_timezone(timezone)
                .single()?
                .to_utc(),
        ))
    });
    let Some((from, to)) = bounds else {
        return fail(StatusCode::BAD_REQUEST, "invalid_query");
    };
    match build_report(pool, &state, &query, from, to).await {
        Ok(result) => Json(result).into_response(),
        Err(error) => database_error(&error),
    }
}

/// Queries the report and converts only when all source currencies have usable rates.
#[allow(clippy::too_many_lines)]
async fn build_report(
    pool: &PgPool,
    state: &AppState,
    q: &ReportQuery,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Result<Value, anyhow::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    let predicate = "created_at >= $1 AND created_at < $2 AND ($3::text IS NULL OR project_id=$3) AND ($4::text IS NULL OR provider_id=$4) AND ($5::text IS NULL OR model_id=$5)";
    let totals_sql = format!(
        "SELECT billing_currency, SUM(billing_amount)::text AS amount, COUNT(*) AS count FROM request_logs WHERE {predicate} AND billing_amount IS NOT NULL GROUP BY billing_currency ORDER BY billing_currency"
    );
    let daily_sql = format!(
        "SELECT (created_at AT TIME ZONE 'UTC' + make_interval(secs => $6::int))::date::text AS day, billing_currency, SUM(billing_amount)::text AS amount FROM request_logs WHERE {predicate} AND billing_amount IS NOT NULL GROUP BY day, billing_currency ORDER BY day, billing_currency"
    );
    let counts_sql = format!(
        "SELECT COUNT(*) FILTER (WHERE billing_amount IS NULL) AS unpriced, COUNT(*) AS attempts FROM request_logs WHERE {predicate}"
    );
    let rows_sql = format!(
        "SELECT request_uid, parent_request_uid, attempt_index, created_at, project_id, project_name, provider_id, provider_name, model_id, model_name, status_code, billing_currency, billing_amount::text AS amount, billing_status, billing_details FROM request_logs WHERE {predicate} ORDER BY created_at DESC, id DESC LIMIT 51 OFFSET $6"
    );
    let totals = sqlx::query(&totals_sql)
        .bind(from)
        .bind(to)
        .bind(&q.project_id)
        .bind(&q.provider_id)
        .bind(&q.model_id)
        .fetch_all(&mut *tx)
        .await?;
    let daily = sqlx::query(&daily_sql)
        .bind(from)
        .bind(to)
        .bind(&q.project_id)
        .bind(&q.provider_id)
        .bind(&q.model_id)
        .bind(crate::db::timezone_offset_secs(&state.config.ui.timezone))
        .fetch_all(&mut *tx)
        .await?;
    let counts = sqlx::query(&counts_sql)
        .bind(from)
        .bind(to)
        .bind(&q.project_id)
        .bind(&q.provider_id)
        .bind(&q.model_id)
        .fetch_one(&mut *tx)
        .await?;
    let rows = sqlx::query(&rows_sql)
        .bind(from)
        .bind(to)
        .bind(&q.project_id)
        .bind(&q.provider_id)
        .bind(&q.model_id)
        .bind((q.page.unwrap_or(1) - 1) * 50)
        .fetch_all(&mut *tx)
        .await?;
    let mut amounts = BTreeMap::new();
    let mut summaries = Vec::new();
    for row in totals {
        let currency: String = row.try_get("billing_currency")?;
        let amount: String = row.try_get("amount")?;
        amounts.insert(currency.clone(), Decimal::from_str(&amount)?);
        summaries.push(json!({ "currency": currency, "amount": amount, "count": row.try_get::<i64,_>("count")? }));
    }
    let raw: Option<Value> =
        sqlx::query_scalar("SELECT billing_fx_rates FROM catalog_state WHERE singleton")
            .fetch_one(&mut *tx)
            .await?;
    tx.commit().await?;
    let snapshot: Option<RateSnapshot> = raw.map(serde_json::from_value).transpose()?;
    let display = state.config.billing.display_currency.as_deref();
    let converted = display
        .and_then(|currency| (!amounts.is_empty()).then_some(currency))
        .and_then(|currency| convert_totals(&amounts, currency, snapshot.as_ref()));
    let daily: Vec<Value> = daily.into_iter().map(|row| Ok(json!({ "date": row.try_get::<String,_>("day")?, "currency": row.try_get::<String,_>("billing_currency")?, "amount": row.try_get::<String,_>("amount")? }))).collect::<Result<_,sqlx::Error>>()?;
    let mut grouped: BTreeMap<String, BTreeMap<String, Decimal>> = BTreeMap::new();
    for item in &daily {
        if let (Some(date), Some(currency), Some(amount)) = (
            item["date"].as_str(),
            item["currency"].as_str(),
            item["amount"].as_str(),
        ) {
            grouped
                .entry(date.to_owned())
                .or_default()
                .insert(currency.to_owned(), Decimal::from_str(amount)?);
        }
    }
    let daily_converted: BTreeMap<String, Option<String>> = grouped
        .into_iter()
        .map(|(date, amounts)| {
            (
                date,
                display
                    .and_then(|currency| convert_totals(&amounts, currency, snapshot.as_ref()))
                    .map(|value| value.to_string()),
            )
        })
        .collect();
    let has_next = rows.len() > 50;
    let items: Vec<Value> = rows
        .into_iter()
        .take(50)
        .map(|row| attempt_json(&row, display, snapshot.as_ref()))
        .collect::<Result<_, _>>()?;
    Ok(
        json!({ "totals": summaries, "daily": daily, "dailyConverted": daily_converted, "attempts": counts.try_get::<i64,_>("attempts")?, "unpriced": counts.try_get::<i64,_>("unpriced")?,
        "items": items, "hasNext": has_next, "displayCurrency": display, "convertedTotal": converted.map(|value| value.to_string()), "fx": snapshot }),
    )
}

/// Query for all upstream attempts of one original request.
#[derive(Debug, Deserialize)]
struct AttemptsQuery {
    /// Identifier of any logged attempt in the group.
    request_uid: Uuid,
    /// One-based page of attempts.
    page: Option<i64>,
}

/// Lists the complete retry chain, including attempts outside the report filters.
async fn attempts(State(state): State<AppState>, Query(query): Query<AttemptsQuery>) -> Response {
    if query
        .page
        .is_some_and(|page| !(1..=100_000).contains(&page))
    {
        return fail(StatusCode::BAD_REQUEST, "invalid_query");
    }
    let Some(pool) = state.db_pool.as_ref() else {
        return fail(StatusCode::SERVICE_UNAVAILABLE, "billing_unavailable");
    };
    match fetch_attempts(pool, &state, &query).await {
        Ok(Some(result)) => Json(result).into_response(),
        Ok(None) => fail(StatusCode::NOT_FOUND, "request_not_found"),
        Err(error) => database_error(&error),
    }
}

/// Reads one retry chain and its snapshot from the same database revision.
async fn fetch_attempts(
    pool: &PgPool,
    state: &AppState,
    query: &AttemptsQuery,
) -> Result<Option<Value>, anyhow::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    let root: Option<Uuid> = sqlx::query_scalar(
        "SELECT coalesce(parent_request_uid,request_uid) FROM request_logs WHERE request_uid=$1",
    )
    .bind(query.request_uid)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(root) = root else {
        return Ok(None);
    };
    let rows = sqlx::query(
        "SELECT request_uid, parent_request_uid, attempt_index, created_at, project_id, project_name, provider_id, provider_name, model_id, model_name, status_code, billing_currency, billing_amount::text AS amount, billing_status, billing_details FROM request_logs WHERE parent_request_uid=$1 OR (request_uid=$1 AND parent_request_uid IS NULL) ORDER BY attempt_index, created_at, id LIMIT 51 OFFSET $2",
    ).bind(root).bind((query.page.unwrap_or(1)-1)*50).fetch_all(&mut *tx).await?;
    let totals = sqlx::query("SELECT billing_currency, sum(billing_amount)::text AS amount, count(*) AS count FROM request_logs WHERE (parent_request_uid=$1 OR (request_uid=$1 AND parent_request_uid IS NULL)) AND billing_amount IS NOT NULL GROUP BY billing_currency ORDER BY billing_currency")
        .bind(root).fetch_all(&mut *tx).await?;
    let unpriced: i64 = sqlx::query_scalar("SELECT count(*) FROM request_logs WHERE (parent_request_uid=$1 OR (request_uid=$1 AND parent_request_uid IS NULL)) AND billing_amount IS NULL")
        .bind(root).fetch_one(&mut *tx).await?;
    let raw: Option<Value> =
        sqlx::query_scalar("SELECT billing_fx_rates FROM catalog_state WHERE singleton")
            .fetch_one(&mut *tx)
            .await?;
    tx.commit().await?;
    let snapshot: Option<RateSnapshot> = raw.map(serde_json::from_value).transpose()?;
    let display = state.config.billing.display_currency.as_deref();
    let has_next = rows.len() > 50;
    let items: Vec<Value> = rows
        .iter()
        .take(50)
        .map(|row| attempt_json(row, display, snapshot.as_ref()))
        .collect::<Result<_, _>>()?;
    let totals: Vec<Value> = totals.iter().map(|row| Ok(json!({"currency":row.try_get::<String,_>("billing_currency")?,"amount":row.try_get::<String,_>("amount")?,"count":row.try_get::<i64,_>("count")?}))).collect::<Result<_,sqlx::Error>>()?;
    Ok(Some(
        json!({"requestUid":root,"items":items,"totals":totals,"unpriced":unpriced,"hasNext":has_next}),
    ))
}

/// Serializes one attempt with an optional reference conversion.
fn attempt_json(
    row: &PgRow,
    display: Option<&str>,
    snapshot: Option<&RateSnapshot>,
) -> Result<Value, sqlx::Error> {
    let currency: Option<String> = row.try_get("billing_currency")?;
    let amount: Option<String> = row.try_get("amount")?;
    let converted = match (&currency, &amount, display) {
        (Some(currency), Some(amount), Some(target)) => {
            let values = BTreeMap::from([(
                currency.clone(),
                Decimal::from_str(amount).map_err(|error| sqlx::Error::Decode(Box::new(error)))?,
            )]);
            convert_totals(&values, target, snapshot).map(|value| value.to_string())
        }
        _ => None,
    };
    Ok(json!({
        "requestUid": row.try_get::<Uuid,_>("request_uid")?, "parentRequestUid": row.try_get::<Option<Uuid>,_>("parent_request_uid")?,
        "attemptIndex": row.try_get::<i16,_>("attempt_index")?, "createdAt": row.try_get::<DateTime<Utc>,_>("created_at")?,
        "projectId": row.try_get::<String,_>("project_id")?, "projectName": row.try_get::<String,_>("project_name")?,
        "providerId": row.try_get::<String,_>("provider_id")?, "providerName": row.try_get::<String,_>("provider_name")?,
        "modelId": row.try_get::<String,_>("model_id")?, "modelName": row.try_get::<String,_>("model_name")?,
        "statusCode": row.try_get::<i32,_>("status_code")?, "currency": currency,
        "amount": amount, "convertedAmount": converted, "billingStatus": row.try_get::<Option<String>,_>("billing_status")?,
        "details": row.try_get::<Option<Value>,_>("billing_details")?
    }))
}

/// Converts an internal database failure to a safe response.
fn database_error(error: &anyhow::Error) -> Response {
    tracing::warn!(%error, "billing request failed");
    fail(StatusCode::SERVICE_UNAVAILABLE, "billing_unavailable")
}

/// Returns a short machine-readable error.
fn fail(status: StatusCode, code: &str) -> Response {
    (
        status,
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({"error": code})),
    )
        .into_response()
}
