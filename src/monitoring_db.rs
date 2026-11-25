//! Time-series monitoring aggregation queries across `traffic`, `performance`, `routing`, and `cost`.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::str::FromStr;

use anyhow::Result;
use chrono::{DateTime, Duration, FixedOffset, NaiveDateTime, Timelike, Utc};
use rust_decimal::Decimal;
use rust_decimal::prelude::ToPrimitive;
use serde_json::Value;
use sqlx::{PgPool, Row};

use crate::billing::fx::{RateSnapshot, convert_totals};
use crate::catalog::RuntimeCatalog;
use crate::config::{BillingConfig, UiConfig};
use crate::db::timezone_offset_secs;
use crate::models::{
    CallModelMappingStat, CostBucket, CostComponentTotals, CostDetailRow, CostMonitoringResponse,
    CostRankItem, CostSeriesMeta, CostSummary, CurrencyTotal, ErrorBucket, ErrorDetailRow,
    ErrorEntityStat, ErrorsMonitoringResponse, ErrorsSummary, FilterEntityItem,
    ModelPerformancePoint, MonitoringMeta, NamedCount, PerformanceBucket,
    PerformanceMonitoringResponse, PerformanceSummary, ProviderPerfItem, ProviderRoutingStat,
    RouteRuleStat, RoutingBucket, RoutingMonitoringResponse, RoutingSummary, StreamComparisonItem,
    StreamSplit, TrafficBucket, TrafficMonitoringResponse, TrafficSummaryTotals, UsageSlice,
};

/// Normalized monitoring query parameters.
#[derive(Debug, Clone)]
pub struct MonitoringFilter<'a> {
    /// Range key (`1h`, `6h`, `24h`, `7d`, `30d`, `90d`).
    pub range: &'a str,
    /// Requested granularity (`auto`, `minute`, `hour`, `day`).
    pub granularity: &'a str,
    /// Optional project filter.
    pub project_id: Option<&'a str>,
    /// Optional provider filter.
    pub provider_id: Option<&'a str>,
    /// Optional model filter.
    pub model_id: Option<&'a str>,
    /// Optional stream mode filter (`all`, `stream`, `non_stream`).
    pub stream_mode: Option<&'a str>,
}

/// Resolved time window and bucket stepping parameters.
#[derive(Debug, Clone)]
struct TimeWindow {
    /// Canonical range string.
    range_key: String,
    /// Canonical granularity (`minute`, `hour`, `day`).
    granularity: &'static str,
    /// PostgreSQL `date_trunc` unit.
    pg_unit: &'static str,
    /// UTC start timestamp (inclusive).
    start_utc: DateTime<Utc>,
    /// Display timezone offset in seconds.
    offset_secs: i32,
    /// Duration of one bucket in minutes (`1.0`, `60.0`, `1440.0`).
    bucket_minutes: f64,
    /// Ordered local bucket keys and formatted labels.
    buckets: Vec<(NaiveDateTime, String)>,
}

/// Resolves a `FixedOffset` from seconds without panicking.
fn fixed_offset(offset_secs: i32) -> FixedOffset {
    FixedOffset::east_opt(offset_secs).unwrap_or_else(|| {
        FixedOffset::east_opt(0)
            .unwrap_or(FixedOffset::west_opt(0).unwrap_or_else(|| unreachable!()))
    })
}

/// Resolves time window, granularity, and continuous bucket keys.
fn resolve_window(range: &str, granularity: &str, timezone: &str) -> TimeWindow {
    let (range_key, total_secs, default_gran) = match range {
        "1h" => ("1h", 3_600_i64, "minute"),
        "6h" => ("6h", 6 * 3_600, "hour"),
        "7d" => ("7d", 7 * 86_400, "hour"),
        "30d" => ("30d", 30 * 86_400, "day"),
        "90d" => ("90d", 90 * 86_400, "day"),
        _ => ("24h", 86_400, "hour"),
    };

    let resolved_gran = match granularity {
        "minute" if total_secs <= 6 * 3_600 => "minute",
        "hour" if total_secs <= 30 * 86_400 => "hour",
        "day" => "day",
        _ => default_gran,
    };

    let offset_secs = timezone_offset_secs(timezone);
    let tz = fixed_offset(offset_secs);
    let now_local = Utc::now().with_timezone(&tz).naive_local();

    let (step, pg_unit, end_bucket, start_bucket) = match resolved_gran {
        "minute" => {
            let end_b = truncate_minute(now_local);
            let count = (total_secs / 60).max(1) - 1;
            (
                Duration::minutes(1),
                "minute",
                end_b,
                end_b - Duration::minutes(count),
            )
        }
        "hour" => {
            let end_b = truncate_hour(now_local);
            let count = (total_secs / 3_600).max(1) - 1;
            (
                Duration::hours(1),
                "hour",
                end_b,
                end_b - Duration::hours(count),
            )
        }
        _ => {
            let end_b = truncate_day(now_local);
            let count = (total_secs / 86_400).max(1) - 1;
            (
                Duration::days(1),
                "day",
                end_b,
                end_b - Duration::days(count),
            )
        }
    };

    let mut buckets = Vec::new();
    let mut cursor = start_bucket;
    while cursor <= end_bucket {
        let label = match resolved_gran {
            "minute" => cursor.format("%H:%M").to_string(),
            "hour" if total_secs <= 86_400 => cursor.format("%m-%d %H:00").to_string(),
            "hour" => cursor.format("%m-%d %Hh").to_string(),
            _ => cursor.format("%m-%d").to_string(),
        };
        buckets.push((cursor, label));
        cursor += step;
    }

    let start_utc = start_bucket.and_local_timezone(tz).single().map_or_else(
        || Utc::now() - Duration::seconds(total_secs),
        |dt| dt.to_utc(),
    );

    let bucket_minutes = match resolved_gran {
        "minute" => 1.0,
        "hour" => 60.0,
        _ => 1440.0,
    };

    TimeWindow {
        range_key: range_key.to_string(),
        granularity: resolved_gran,
        pg_unit,
        start_utc,
        offset_secs,
        bucket_minutes,
        buckets,
    }
}

/// Truncates a naive timestamp to minute precision.
fn truncate_minute(dt: NaiveDateTime) -> NaiveDateTime {
    dt.date()
        .and_hms_opt(dt.hour(), dt.minute(), 0)
        .unwrap_or(dt)
}

/// Truncates a naive timestamp to hour precision.
fn truncate_hour(dt: NaiveDateTime) -> NaiveDateTime {
    dt.date().and_hms_opt(dt.hour(), 0, 0).unwrap_or(dt)
}

/// Truncates a naive timestamp to day precision.
fn truncate_day(dt: NaiveDateTime) -> NaiveDateTime {
    dt.date().and_hms_opt(0, 0, 0).unwrap_or(dt)
}

/// Builds `MonitoringMeta` with catalog filter options.
#[must_use]
pub fn build_meta(
    catalog: &RuntimeCatalog,
    ui_cfg: &UiConfig,
    range: &str,
    granularity: &str,
) -> MonitoringMeta {
    let win = resolve_window(range, granularity, &ui_cfg.timezone);
    let projects = catalog
        .projects
        .iter()
        .map(|p| FilterEntityItem {
            id: p.id.clone(),
            name: p.name.clone(),
            icon: p.icon.clone(),
        })
        .collect();
    let providers = catalog
        .providers
        .iter()
        .map(|p| FilterEntityItem {
            id: p.id.clone(),
            name: p.name.clone(),
            icon: p.icon.clone(),
        })
        .collect();
    let mut seen_models = BTreeSet::new();
    let mut models = Vec::new();
    for provider in &catalog.providers {
        for model in &provider.models {
            if seen_models.insert(model.id.clone()) {
                models.push(FilterEntityItem {
                    id: model.id.clone(),
                    name: model.name.clone(),
                    icon: model.icon.clone(),
                });
            }
        }
    }
    MonitoringMeta {
        range: win.range_key,
        granularity: win.granularity.to_string(),
        timezone: ui_cfg.timezone.clone(),
        projects,
        providers,
        models,
    }
}

/// Groups items into Top N plus an aggregated `"其他"` bucket when needed.
fn top_n_slices(mut items: Vec<UsageSlice>, limit: usize) -> Vec<UsageSlice> {
    items.sort_by_key(|a| std::cmp::Reverse(a.total_tokens));
    if items.len() <= limit {
        return items;
    }
    let rest = items.split_off(limit);
    let other_tokens: i64 = rest.iter().map(|s| s.total_tokens).sum();
    let other_reqs: i64 = rest.iter().map(|s| s.request_count).sum();
    if other_tokens > 0 || other_reqs > 0 {
        items.push(UsageSlice {
            id: "__other__".to_string(),
            name: "其他".to_string(),
            total_tokens: other_tokens,
            request_count: other_reqs,
        });
    }
    items
}

/// Queries the `traffic` (用量) monitoring dimension.
///
/// # Errors
/// Returns an error if any PostgreSQL query fails.
#[allow(clippy::too_many_lines)]
pub async fn query_traffic_monitoring(
    pool: &PgPool,
    catalog: &RuntimeCatalog,
    ui_cfg: &UiConfig,
    filter: &MonitoringFilter<'_>,
) -> Result<TrafficMonitoringResponse> {
    let win = resolve_window(filter.range, filter.granularity, &ui_cfg.timezone);
    let meta = build_meta(catalog, ui_cfg, filter.range, filter.granularity);
    let bmin = win.bucket_minutes.max(1.0);

    let rows = sqlx::query(
        r"
        SELECT
            date_trunc($1, created_at AT TIME ZONE 'UTC' + make_interval(secs => $2::int)) AS bucket,
            COUNT(*)::BIGINT AS total_requests,
            COUNT(*) FILTER (WHERE status_code >= 200 AND status_code < 400)::BIGINT AS success_requests,
            COUNT(*) FILTER (WHERE status_code >= 400 OR status_code < 200)::BIGINT AS error_requests,
            COALESCE(SUM(input_tokens), 0)::BIGINT AS input_tokens,
            COALESCE(SUM(output_tokens), 0)::BIGINT AS output_tokens,
            COALESCE(SUM(cache_read_tokens), 0)::BIGINT AS cache_read_tokens,
            COALESCE(SUM(cache_creation_tokens), 0)::BIGINT AS cache_creation_tokens,
            COALESCE(SUM(reasoning_tokens), 0)::BIGINT AS reasoning_tokens,
            COALESCE(SUM((SELECT COALESCE(SUM(val::BIGINT), 0) FROM jsonb_each_text(extra_tokens) AS kv(k, val))), 0)::BIGINT AS extra_tokens_total,
            COALESCE(AVG(input_tokens), 0)::DOUBLE PRECISION AS avg_input_tokens,
            COALESCE(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY input_tokens), 0)::DOUBLE PRECISION AS p90_input_tokens,
            COALESCE(AVG(output_tokens), 0)::DOUBLE PRECISION AS avg_output_tokens,
            COALESCE(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY output_tokens), 0)::DOUBLE PRECISION AS p90_output_tokens,
            COUNT(*) FILTER (WHERE input_tokens < 32000)::BIGINT AS req_0_32k,
            COUNT(*) FILTER (WHERE input_tokens >= 32000 AND input_tokens < 128000)::BIGINT AS req_32k_128k,
            COUNT(*) FILTER (WHERE input_tokens >= 128000)::BIGINT AS req_128k_plus,
            COALESCE(SUM(total_tokens) FILTER (WHERE input_tokens < 32000), 0)::BIGINT AS tok_0_32k,
            COALESCE(SUM(total_tokens) FILTER (WHERE input_tokens >= 32000 AND input_tokens < 128000), 0)::BIGINT AS tok_32k_128k,
            COALESCE(SUM(total_tokens) FILTER (WHERE input_tokens >= 128000), 0)::BIGINT AS tok_128k_plus
        FROM request_logs
        WHERE created_at >= $3
          AND ($4::TEXT IS NULL OR project_id = $4)
          AND ($5::TEXT IS NULL OR provider_id = $5)
          AND ($6::TEXT IS NULL OR model_id = $6)
        GROUP BY bucket
        ORDER BY bucket ASC
        ",
    )
    .bind(win.pg_unit)
    .bind(win.offset_secs)
    .bind(win.start_utc)
    .bind(filter.project_id)
    .bind(filter.provider_id)
    .bind(filter.model_id)
    .fetch_all(pool)
    .await?;

    let mut totals = TrafficSummaryTotals::default();
    let mut map: HashMap<NaiveDateTime, TrafficBucket> = HashMap::with_capacity(rows.len());
    for row in rows {
        let bucket_dt: NaiveDateTime = row.try_get("bucket")?;
        let total_requests: i64 = row.try_get("total_requests")?;
        let error_requests: i64 = row.try_get("error_requests")?;
        let input_tokens: i64 = row.try_get("input_tokens")?;
        let output_tokens: i64 = row.try_get("output_tokens")?;
        let cache_read_tokens: i64 = row.try_get("cache_read_tokens")?;
        let cache_creation_tokens: i64 = row.try_get("cache_creation_tokens")?;
        let reasoning_tokens: i64 = row.try_get("reasoning_tokens")?;
        let extra_tokens_total: i64 = row.try_get("extra_tokens_total")?;

        totals.total_requests += total_requests;
        totals.input_tokens += input_tokens;
        totals.output_tokens += output_tokens;
        totals.cache_read_tokens += cache_read_tokens;
        totals.cache_creation_tokens += cache_creation_tokens;
        totals.reasoning_tokens += reasoning_tokens;
        totals.extra_tokens += extra_tokens_total;
        totals.total_tokens += input_tokens + output_tokens;

        let denom = input_tokens + cache_read_tokens;
        #[allow(clippy::cast_precision_loss)]
        let cache_hit_rate = if denom > 0 {
            ((cache_read_tokens as f64) * 100.0 / (denom as f64)).min(100.0)
        } else {
            0.0
        };
        #[allow(clippy::cast_precision_loss)]
        let error_rate = if total_requests > 0 {
            (error_requests as f64) * 100.0 / (total_requests as f64)
        } else {
            0.0
        };

        let req_0_32k: i64 = row.try_get("req_0_32k")?;
        let req_32k_128k: i64 = row.try_get("req_32k_128k")?;
        let req_128k_plus: i64 = row.try_get("req_128k_plus")?;
        let tok_0_32k: i64 = row.try_get("tok_0_32k")?;
        let tok_32k_128k: i64 = row.try_get("tok_32k_128k")?;
        let tok_128k_plus: i64 = row.try_get("tok_128k_plus")?;

        #[allow(clippy::cast_precision_loss)]
        map.insert(
            bucket_dt,
            TrafficBucket {
                label: String::new(),
                total_requests,
                success_requests: row.try_get("success_requests")?,
                error_requests,
                rpm: total_requests as f64 / bmin,
                error_rate,
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cache_creation_tokens,
                reasoning_tokens,
                extra_tokens_total,
                cache_hit_rate,
                avg_input_tokens: row.try_get("avg_input_tokens")?,
                p90_input_tokens: row.try_get("p90_input_tokens")?,
                avg_output_tokens: row.try_get("avg_output_tokens")?,
                p90_output_tokens: row.try_get("p90_output_tokens")?,
                tpm_in: input_tokens as f64 / bmin,
                tpm_out: output_tokens as f64 / bmin,
                tpm_total: (input_tokens + output_tokens) as f64 / bmin,
                rpm_0_32k: req_0_32k as f64 / bmin,
                rpm_32k_128k: req_32k_128k as f64 / bmin,
                rpm_128k_plus: req_128k_plus as f64 / bmin,
                tpm_0_32k: tok_0_32k as f64 / bmin,
                tpm_32k_128k: tok_32k_128k as f64 / bmin,
                tpm_128k_plus: tok_128k_plus as f64 / bmin,
            },
        );
    }

    #[allow(clippy::cast_precision_loss)]
    let total_window_mins = (win.buckets.len().max(1) as f64) * bmin;
    #[allow(clippy::cast_precision_loss)]
    {
        totals.avg_rpm = totals.total_requests as f64 / total_window_mins;
        let tot_denom = totals.input_tokens + totals.cache_read_tokens;
        totals.cache_hit_rate = if tot_denom > 0 {
            ((totals.cache_read_tokens as f64) * 100.0 / (tot_denom as f64)).min(100.0)
        } else {
            0.0
        };
    }

    let buckets = win
        .buckets
        .into_iter()
        .map(|(dt, label)| match map.remove(&dt) {
            Some(mut item) => {
                item.label = label;
                item
            }
            None => TrafficBucket {
                label,
                total_requests: 0,
                success_requests: 0,
                error_requests: 0,
                rpm: 0.0,
                error_rate: 0.0,
                input_tokens: 0,
                output_tokens: 0,
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
                reasoning_tokens: 0,
                extra_tokens_total: 0,
                cache_hit_rate: 0.0,
                avg_input_tokens: 0.0,
                p90_input_tokens: 0.0,
                avg_output_tokens: 0.0,
                p90_output_tokens: 0.0,
                tpm_in: 0.0,
                tpm_out: 0.0,
                tpm_total: 0.0,
                rpm_0_32k: 0.0,
                rpm_32k_128k: 0.0,
                rpm_128k_plus: 0.0,
                tpm_0_32k: 0.0,
                tpm_32k_128k: 0.0,
                tpm_128k_plus: 0.0,
            },
        })
        .collect();

    let by_model =
        query_usage_slices(pool, "model_id", "model_name", win.start_utc, filter).await?;
    let by_project =
        query_usage_slices(pool, "project_id", "project_name", win.start_utc, filter).await?;
    let by_provider =
        query_usage_slices(pool, "provider_id", "provider_name", win.start_utc, filter).await?;
    let by_call_model = query_usage_slices(
        pool,
        "call_model_id",
        "call_model_name",
        win.start_utc,
        filter,
    )
    .await?;

    Ok(TrafficMonitoringResponse {
        meta,
        totals,
        buckets,
        distribution_by_model: top_n_slices(by_model, 6),
        distribution_by_project: top_n_slices(by_project, 6),
        distribution_by_provider: top_n_slices(by_provider, 6),
        distribution_by_call_model: top_n_slices(by_call_model, 6),
    })
}

/// Shared helper querying `UsageSlice` breakdowns by an arbitrary `(id_col, name_col)` pair.
async fn query_usage_slices(
    pool: &PgPool,
    id_col: &str,
    name_col: &str,
    start_utc: DateTime<Utc>,
    filter: &MonitoringFilter<'_>,
) -> Result<Vec<UsageSlice>> {
    let sql = format!(
        r"
        SELECT
            {id_col} AS id,
            MAX({name_col}) AS name,
            COALESCE(SUM(total_tokens), 0)::BIGINT AS total_tokens,
            COUNT(*)::BIGINT AS request_count
        FROM request_logs
        WHERE created_at >= $1
          AND ($2::TEXT IS NULL OR project_id = $2)
          AND ($3::TEXT IS NULL OR provider_id = $3)
          AND ($4::TEXT IS NULL OR model_id = $4)
        GROUP BY {id_col}
        "
    );
    let rows = sqlx::query(&sql)
        .bind(start_utc)
        .bind(filter.project_id)
        .bind(filter.provider_id)
        .bind(filter.model_id)
        .fetch_all(pool)
        .await?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        out.push(UsageSlice {
            id: row.try_get("id")?,
            name: row.try_get("name")?,
            total_tokens: row.try_get("total_tokens")?,
            request_count: row.try_get("request_count")?,
        });
    }
    Ok(out)
}

/// Queries the `performance` (性能) monitoring dimension.
///
/// # Errors
/// Returns an error if any PostgreSQL query fails.
#[allow(clippy::too_many_lines)]
pub async fn query_performance_monitoring(
    pool: &PgPool,
    catalog: &RuntimeCatalog,
    ui_cfg: &UiConfig,
    filter: &MonitoringFilter<'_>,
) -> Result<PerformanceMonitoringResponse> {
    let win = resolve_window(filter.range, filter.granularity, &ui_cfg.timezone);
    let meta = build_meta(catalog, ui_cfg, filter.range, filter.granularity);
    let stream_flag: Option<bool> = match filter.stream_mode {
        Some("stream") => Some(true),
        Some("non_stream") => Some(false),
        _ => None,
    };

    let rows = sqlx::query(
        r"
        SELECT
            date_trunc($1, created_at AT TIME ZONE 'UTC' + make_interval(secs => $2::int)) AS bucket,
            COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ttft_ms), 0)::DOUBLE PRECISION AS ttft_p50,
            COALESCE(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY ttft_ms), 0)::DOUBLE PRECISION AS ttft_p90,
            COALESCE(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY ttft_ms), 0)::DOUBLE PRECISION AS ttft_p99,
            COALESCE(AVG(decode_tps) FILTER (WHERE decode_tps > 0), 0)::DOUBLE PRECISION AS decode_tps_avg,
            COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY decode_tps) FILTER (WHERE decode_tps > 0), 0)::DOUBLE PRECISION AS decode_tps_p50,
            COALESCE(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY decode_tps) FILTER (WHERE decode_tps > 0), 0)::DOUBLE PRECISION AS decode_tps_p90,
            COALESCE(AVG(ttft_ms), 0)::DOUBLE PRECISION AS avg_ttft_ms,
            COALESCE(AVG(generation_duration_ms), 0)::DOUBLE PRECISION AS avg_generation_ms,
            COALESCE(AVG(total_duration_ms), 0)::DOUBLE PRECISION AS avg_total_duration_ms,
            COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY total_duration_ms), 0)::DOUBLE PRECISION AS duration_p50,
            COALESCE(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY total_duration_ms), 0)::DOUBLE PRECISION AS duration_p90,
            COALESCE(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY total_duration_ms), 0)::DOUBLE PRECISION AS duration_p99,
            COALESCE(AVG(e2e_tps) FILTER (WHERE e2e_tps > 0), 0)::DOUBLE PRECISION AS avg_e2e_tps,
            COALESCE(AVG(generation_duration_ms / output_tokens) FILTER (WHERE is_stream AND output_tokens > 0 AND generation_duration_ms > 0), 0)::DOUBLE PRECISION AS tpot_avg,
            COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY generation_duration_ms / output_tokens) FILTER (WHERE is_stream AND output_tokens > 0 AND generation_duration_ms > 0), 0)::DOUBLE PRECISION AS tpot_p50,
            COALESCE(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY generation_duration_ms / output_tokens) FILTER (WHERE is_stream AND output_tokens > 0 AND generation_duration_ms > 0), 0)::DOUBLE PRECISION AS tpot_p90,
            COALESCE(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY generation_duration_ms / output_tokens) FILTER (WHERE is_stream AND output_tokens > 0 AND generation_duration_ms > 0), 0)::DOUBLE PRECISION AS tpot_p99,
            COALESCE(AVG(gateway_overhead_ms) FILTER (WHERE gateway_overhead_ms > 0), 0)::DOUBLE PRECISION AS avg_gateway_overhead_ms,
            COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY gateway_overhead_ms) FILTER (WHERE gateway_overhead_ms > 0), 0)::DOUBLE PRECISION AS p50_gateway_overhead_ms,
            COALESCE(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY gateway_overhead_ms) FILTER (WHERE gateway_overhead_ms > 0), 0)::DOUBLE PRECISION AS p90_gateway_overhead_ms,
            COALESCE(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY gateway_overhead_ms) FILTER (WHERE gateway_overhead_ms > 0), 0)::DOUBLE PRECISION AS p99_gateway_overhead_ms,
            COALESCE(AVG(routing_ms) FILTER (WHERE routing_ms > 0), 0)::DOUBLE PRECISION AS avg_routing_ms,
            COALESCE(AVG(attempt_prep_ms) FILTER (WHERE attempt_prep_ms > 0), 0)::DOUBLE PRECISION AS avg_attempt_prep_ms,
            COALESCE(AVG(upstream_header_ms) FILTER (WHERE upstream_header_ms > 0), 0)::DOUBLE PRECISION AS avg_upstream_header_ms
        FROM request_logs
        WHERE created_at >= $3
          AND status_code >= 200 AND status_code < 400
          AND ($4::TEXT IS NULL OR project_id = $4)
          AND ($5::TEXT IS NULL OR provider_id = $5)
          AND ($6::TEXT IS NULL OR model_id = $6)
          AND ($7::BOOLEAN IS NULL OR is_stream = $7)
        GROUP BY bucket
        ORDER BY bucket ASC
        ",
    )
    .bind(win.pg_unit)
    .bind(win.offset_secs)
    .bind(win.start_utc)
    .bind(filter.project_id)
    .bind(filter.provider_id)
    .bind(filter.model_id)
    .bind(stream_flag)
    .fetch_all(pool)
    .await?;

    let mut map: HashMap<NaiveDateTime, PerformanceBucket> = HashMap::with_capacity(rows.len());
    for row in rows {
        let bucket_dt: NaiveDateTime = row.try_get("bucket")?;
        map.insert(
            bucket_dt,
            PerformanceBucket {
                label: String::new(),
                ttft_p50: row.try_get("ttft_p50")?,
                ttft_p90: row.try_get("ttft_p90")?,
                ttft_p99: row.try_get("ttft_p99")?,
                decode_tps_avg: row.try_get("decode_tps_avg")?,
                decode_tps_p50: row.try_get("decode_tps_p50")?,
                decode_tps_p90: row.try_get("decode_tps_p90")?,
                avg_ttft_ms: row.try_get("avg_ttft_ms")?,
                avg_generation_ms: row.try_get("avg_generation_ms")?,
                avg_total_duration_ms: row.try_get("avg_total_duration_ms")?,
                duration_p50: row.try_get("duration_p50")?,
                duration_p90: row.try_get("duration_p90")?,
                duration_p99: row.try_get("duration_p99")?,
                avg_e2e_tps: row.try_get("avg_e2e_tps")?,
                tpot_avg: row.try_get("tpot_avg")?,
                tpot_p50: row.try_get("tpot_p50")?,
                tpot_p90: row.try_get("tpot_p90")?,
                tpot_p99: row.try_get("tpot_p99")?,
                avg_gateway_overhead_ms: row.try_get("avg_gateway_overhead_ms")?,
                p50_gateway_overhead_ms: row.try_get("p50_gateway_overhead_ms")?,
                p90_gateway_overhead_ms: row.try_get("p90_gateway_overhead_ms")?,
                p99_gateway_overhead_ms: row.try_get("p99_gateway_overhead_ms")?,
                avg_routing_ms: row.try_get("avg_routing_ms")?,
                avg_attempt_prep_ms: row.try_get("avg_attempt_prep_ms")?,
                avg_upstream_header_ms: row.try_get("avg_upstream_header_ms")?,
            },
        );
    }

    let buckets = win
        .buckets
        .into_iter()
        .map(|(dt, label)| match map.remove(&dt) {
            Some(mut item) => {
                item.label = label;
                item
            }
            None => PerformanceBucket {
                label,
                ttft_p50: 0.0,
                ttft_p90: 0.0,
                ttft_p99: 0.0,
                decode_tps_avg: 0.0,
                decode_tps_p50: 0.0,
                decode_tps_p90: 0.0,
                avg_ttft_ms: 0.0,
                avg_generation_ms: 0.0,
                avg_total_duration_ms: 0.0,
                duration_p50: 0.0,
                duration_p90: 0.0,
                duration_p99: 0.0,
                avg_e2e_tps: 0.0,
                tpot_avg: 0.0,
                tpot_p50: 0.0,
                tpot_p90: 0.0,
                tpot_p99: 0.0,
                avg_gateway_overhead_ms: 0.0,
                p50_gateway_overhead_ms: 0.0,
                p90_gateway_overhead_ms: 0.0,
                p99_gateway_overhead_ms: 0.0,
                avg_routing_ms: 0.0,
                avg_attempt_prep_ms: 0.0,
                avg_upstream_header_ms: 0.0,
            },
        })
        .collect();

    let sum_row = sqlx::query(
        r"
        SELECT
            COALESCE(AVG(gateway_overhead_ms) FILTER (WHERE gateway_overhead_ms > 0), 0)::DOUBLE PRECISION AS avg_gateway_overhead_ms,
            COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ttft_ms), 0)::DOUBLE PRECISION AS ttft_p50,
            COALESCE(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY ttft_ms), 0)::DOUBLE PRECISION AS ttft_p90,
            COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY generation_duration_ms / output_tokens) FILTER (WHERE is_stream AND output_tokens > 0 AND generation_duration_ms > 0), 0)::DOUBLE PRECISION AS tpot_p50,
            COALESCE(AVG(decode_tps) FILTER (WHERE decode_tps > 0), 0)::DOUBLE PRECISION AS decode_tps_avg,
            COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY decode_tps) FILTER (WHERE decode_tps > 0), 0)::DOUBLE PRECISION AS decode_tps_p50,
            COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY total_duration_ms), 0)::DOUBLE PRECISION AS duration_p50,
            COALESCE(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY total_duration_ms), 0)::DOUBLE PRECISION AS duration_p90
        FROM request_logs
        WHERE created_at >= $1
          AND status_code >= 200 AND status_code < 400
          AND ($2::TEXT IS NULL OR project_id = $2)
          AND ($3::TEXT IS NULL OR provider_id = $3)
          AND ($4::TEXT IS NULL OR model_id = $4)
          AND ($5::BOOLEAN IS NULL OR is_stream = $5)
        ",
    )
    .bind(win.start_utc)
    .bind(filter.project_id)
    .bind(filter.provider_id)
    .bind(filter.model_id)
    .bind(stream_flag)
    .fetch_one(pool)
    .await?;

    let summary = PerformanceSummary {
        avg_gateway_overhead_ms: sum_row.try_get("avg_gateway_overhead_ms")?,
        ttft_p50: sum_row.try_get("ttft_p50")?,
        ttft_p90: sum_row.try_get("ttft_p90")?,
        tpot_p50: sum_row.try_get("tpot_p50")?,
        decode_tps_avg: sum_row.try_get("decode_tps_avg")?,
        decode_tps_p50: sum_row.try_get("decode_tps_p50")?,
        duration_p50: sum_row.try_get("duration_p50")?,
        duration_p90: sum_row.try_get("duration_p90")?,
    };

    let quad_rows = sqlx::query(
        r"
        SELECT
            provider_id,
            MAX(provider_name) AS provider_name,
            model_id,
            MAX(model_name) AS model_name,
            COALESCE(AVG(ttft_ms), 0)::DOUBLE PRECISION AS avg_ttft_ms,
            COALESCE(AVG(decode_tps) FILTER (WHERE decode_tps > 0), 0)::DOUBLE PRECISION AS avg_decode_tps,
            COUNT(*)::BIGINT AS request_count,
            COALESCE(SUM(total_tokens), 0)::BIGINT AS total_tokens
        FROM request_logs
        WHERE created_at >= $1
          AND status_code >= 200 AND status_code < 400
          AND ($2::TEXT IS NULL OR project_id = $2)
          AND ($3::TEXT IS NULL OR provider_id = $3)
          AND ($4::TEXT IS NULL OR model_id = $4)
          AND ($5::BOOLEAN IS NULL OR is_stream = $5)
        GROUP BY provider_id, model_id
        ORDER BY request_count DESC
        LIMIT 10
        ",
    )
    .bind(win.start_utc)
    .bind(filter.project_id)
    .bind(filter.provider_id)
    .bind(filter.model_id)
    .bind(stream_flag)
    .fetch_all(pool)
    .await?;

    let mut model_quadrant = Vec::with_capacity(quad_rows.len());
    for row in quad_rows {
        model_quadrant.push(ModelPerformancePoint {
            provider_id: row.try_get("provider_id")?,
            provider_name: row.try_get("provider_name")?,
            model_id: row.try_get("model_id")?,
            model_name: row.try_get("model_name")?,
            avg_ttft_ms: row.try_get("avg_ttft_ms")?,
            avg_decode_tps: row.try_get("avg_decode_tps")?,
            request_count: row.try_get("request_count")?,
            total_tokens: row.try_get("total_tokens")?,
        });
    }

    let hist_row = sqlx::query(
        r"
        SELECT
            COUNT(*) FILTER (WHERE ttft_ms < 200)::BIGINT AS b0,
            COUNT(*) FILTER (WHERE ttft_ms >= 200 AND ttft_ms < 500)::BIGINT AS b1,
            COUNT(*) FILTER (WHERE ttft_ms >= 500 AND ttft_ms < 1000)::BIGINT AS b2,
            COUNT(*) FILTER (WHERE ttft_ms >= 1000 AND ttft_ms < 3000)::BIGINT AS b3,
            COUNT(*) FILTER (WHERE ttft_ms >= 3000 AND ttft_ms < 10000)::BIGINT AS b4,
            COUNT(*) FILTER (WHERE ttft_ms >= 10000)::BIGINT AS b5
        FROM request_logs
        WHERE created_at >= $1
          AND status_code >= 200 AND status_code < 400
          AND ($2::TEXT IS NULL OR project_id = $2)
          AND ($3::TEXT IS NULL OR provider_id = $3)
          AND ($4::TEXT IS NULL OR model_id = $4)
          AND ($5::BOOLEAN IS NULL OR is_stream = $5)
        ",
    )
    .bind(win.start_utc)
    .bind(filter.project_id)
    .bind(filter.provider_id)
    .bind(filter.model_id)
    .bind(stream_flag)
    .fetch_one(pool)
    .await?;

    let ttft_histogram = vec![
        NamedCount {
            name: "<200ms".to_string(),
            count: hist_row.try_get("b0")?,
        },
        NamedCount {
            name: "200~500ms".to_string(),
            count: hist_row.try_get("b1")?,
        },
        NamedCount {
            name: "0.5~1s".to_string(),
            count: hist_row.try_get("b2")?,
        },
        NamedCount {
            name: "1~3s".to_string(),
            count: hist_row.try_get("b3")?,
        },
        NamedCount {
            name: "3~10s".to_string(),
            count: hist_row.try_get("b4")?,
        },
        NamedCount {
            name: ">10s".to_string(),
            count: hist_row.try_get("b5")?,
        },
    ];

    let prov_rows = sqlx::query(
        r"
        SELECT
            provider_id,
            MAX(provider_name) AS provider_name,
            COALESCE(AVG(ttft_ms), 0)::DOUBLE PRECISION AS avg_ttft_ms,
            COALESCE(AVG(decode_tps) FILTER (WHERE decode_tps > 0), 0)::DOUBLE PRECISION AS avg_decode_tps,
            COALESCE(AVG(generation_duration_ms / output_tokens) FILTER (WHERE is_stream AND output_tokens > 0 AND generation_duration_ms > 0), 0)::DOUBLE PRECISION AS avg_tpot_ms,
            COUNT(*)::BIGINT AS request_count
        FROM request_logs
        WHERE created_at >= $1
          AND status_code >= 200 AND status_code < 400
          AND ($2::TEXT IS NULL OR project_id = $2)
          AND ($3::TEXT IS NULL OR provider_id = $3)
          AND ($4::TEXT IS NULL OR model_id = $4)
          AND ($5::BOOLEAN IS NULL OR is_stream = $5)
        GROUP BY provider_id
        ORDER BY request_count DESC
        LIMIT 10
        ",
    )
    .bind(win.start_utc)
    .bind(filter.project_id)
    .bind(filter.provider_id)
    .bind(filter.model_id)
    .bind(stream_flag)
    .fetch_all(pool)
    .await?;

    let mut provider_benchmarks = Vec::with_capacity(prov_rows.len());
    for row in prov_rows {
        provider_benchmarks.push(ProviderPerfItem {
            provider_id: row.try_get("provider_id")?,
            provider_name: row.try_get("provider_name")?,
            avg_ttft_ms: row.try_get("avg_ttft_ms")?,
            avg_decode_tps: row.try_get("avg_decode_tps")?,
            avg_tpot_ms: row.try_get("avg_tpot_ms")?,
            request_count: row.try_get("request_count")?,
        });
    }

    let stream_rows = sqlx::query(
        r"
        SELECT
            is_stream,
            COUNT(*)::BIGINT AS request_count,
            COALESCE(AVG(ttft_ms), 0)::DOUBLE PRECISION AS avg_ttft_ms,
            COALESCE(AVG(total_duration_ms), 0)::DOUBLE PRECISION AS avg_total_duration_ms,
            COALESCE(AVG(decode_tps) FILTER (WHERE decode_tps > 0), 0)::DOUBLE PRECISION AS avg_decode_tps
        FROM request_logs
        WHERE created_at >= $1
          AND status_code >= 200 AND status_code < 400
          AND ($2::TEXT IS NULL OR project_id = $2)
          AND ($3::TEXT IS NULL OR provider_id = $3)
          AND ($4::TEXT IS NULL OR model_id = $4)
        GROUP BY is_stream
        ORDER BY is_stream DESC
        ",
    )
    .bind(win.start_utc)
    .bind(filter.project_id)
    .bind(filter.provider_id)
    .bind(filter.model_id)
    .fetch_all(pool)
    .await?;

    let mut stream_comparison = Vec::with_capacity(stream_rows.len());
    for row in stream_rows {
        let is_stream: bool = row.try_get("is_stream")?;
        stream_comparison.push(StreamComparisonItem {
            mode: if is_stream { "stream" } else { "non_stream" }.to_string(),
            request_count: row.try_get("request_count")?,
            avg_ttft_ms: row.try_get("avg_ttft_ms")?,
            avg_total_duration_ms: row.try_get("avg_total_duration_ms")?,
            avg_decode_tps: row.try_get("avg_decode_tps")?,
        });
    }

    Ok(PerformanceMonitoringResponse {
        meta,
        summary,
        buckets,
        model_quadrant,
        ttft_histogram,
        provider_benchmarks,
        stream_comparison,
    })
}

/// Per-bucket status & retry counts for the `routing` dimension.
#[derive(Default)]
struct StatusBucketCounts {
    /// Requests succeeding on attempt 1.
    first_try_success: i64,
    /// Requests succeeding after retry/fallback.
    retry_success: i64,
    /// Requests ending in error.
    final_error: i64,
    /// HTTP 2xx count.
    status_2xx: i64,
    /// HTTP 4xx count.
    status_4xx: i64,
    /// HTTP 5xx count.
    status_5xx: i64,
    /// Other status codes.
    status_other: i64,
}

/// Queries the `routing` monitoring dimension.
///
/// # Errors
/// Returns an error if any PostgreSQL query fails.
#[allow(clippy::too_many_lines)]
pub async fn query_routing_monitoring(
    pool: &PgPool,
    catalog: &RuntimeCatalog,
    ui_cfg: &UiConfig,
    filter: &MonitoringFilter<'_>,
) -> Result<RoutingMonitoringResponse> {
    let win = resolve_window(filter.range, filter.granularity, &ui_cfg.timezone);
    let meta = build_meta(catalog, ui_cfg, filter.range, filter.granularity);

    let rule_rows = sqlx::query(
        r"
        SELECT
            date_trunc($1, created_at AT TIME ZONE 'UTC' + make_interval(secs => $2::int)) AS bucket,
            route_rule_id,
            COUNT(*)::BIGINT AS cnt
        FROM request_logs
        WHERE created_at >= $3
          AND ($4::TEXT IS NULL OR project_id = $4)
          AND ($5::TEXT IS NULL OR provider_id = $5)
          AND ($6::TEXT IS NULL OR model_id = $6)
        GROUP BY bucket, route_rule_id
        ",
    )
    .bind(win.pg_unit)
    .bind(win.offset_secs)
    .bind(win.start_utc)
    .bind(filter.project_id)
    .bind(filter.provider_id)
    .bind(filter.model_id)
    .fetch_all(pool)
    .await?;

    let mut rule_totals: HashMap<String, i64> = HashMap::new();
    let mut bucket_rule_raw: HashMap<NaiveDateTime, Vec<(String, i64)>> = HashMap::new();
    for row in rule_rows {
        let dt: NaiveDateTime = row.try_get("bucket")?;
        let rule_id: String = row.try_get("route_rule_id")?;
        let cnt: i64 = row.try_get("cnt")?;
        *rule_totals.entry(rule_id.clone()).or_insert(0) += cnt;
        bucket_rule_raw.entry(dt).or_default().push((rule_id, cnt));
    }

    let mut sorted_rules: Vec<(String, i64)> = rule_totals.into_iter().collect();
    sorted_rules.sort_by_key(|a| std::cmp::Reverse(a.1));
    let top_rules: BTreeSet<String> = sorted_rules
        .iter()
        .take(5)
        .map(|(k, _)| k.clone())
        .collect();
    let has_other_rules = sorted_rules.len() > 5;
    let mut rule_series_keys: Vec<String> =
        sorted_rules.into_iter().take(5).map(|(k, _)| k).collect();
    if has_other_rules {
        rule_series_keys.push("其他".to_string());
    }

    let status_rows = sqlx::query(
        r"
        SELECT
            date_trunc($1, created_at AT TIME ZONE 'UTC' + make_interval(secs => $2::int)) AS bucket,
            COUNT(*) FILTER (WHERE attempt_index = 1 AND status_code >= 200 AND status_code < 300)::BIGINT AS first_try_success,
            COUNT(*) FILTER (WHERE attempt_index > 1 AND status_code >= 200 AND status_code < 300)::BIGINT AS retry_success,
            COUNT(*) FILTER (WHERE status_code >= 400 OR status_code < 200)::BIGINT AS final_error,
            COUNT(*) FILTER (WHERE status_code >= 200 AND status_code < 300)::BIGINT AS status_2xx,
            COUNT(*) FILTER (WHERE status_code >= 400 AND status_code < 500)::BIGINT AS status_4xx,
            COUNT(*) FILTER (WHERE status_code >= 500)::BIGINT AS status_5xx,
            COUNT(*) FILTER (WHERE status_code < 200 OR (status_code >= 300 AND status_code < 400))::BIGINT AS status_other
        FROM request_logs
        WHERE created_at >= $3
          AND ($4::TEXT IS NULL OR project_id = $4)
          AND ($5::TEXT IS NULL OR provider_id = $5)
          AND ($6::TEXT IS NULL OR model_id = $6)
        GROUP BY bucket
        ORDER BY bucket ASC
        ",
    )
    .bind(win.pg_unit)
    .bind(win.offset_secs)
    .bind(win.start_utc)
    .bind(filter.project_id)
    .bind(filter.provider_id)
    .bind(filter.model_id)
    .fetch_all(pool)
    .await?;

    let mut status_map: HashMap<NaiveDateTime, StatusBucketCounts> =
        HashMap::with_capacity(status_rows.len());
    for row in status_rows {
        let dt: NaiveDateTime = row.try_get("bucket")?;
        status_map.insert(
            dt,
            StatusBucketCounts {
                first_try_success: row.try_get("first_try_success")?,
                retry_success: row.try_get("retry_success")?,
                final_error: row.try_get("final_error")?,
                status_2xx: row.try_get("status_2xx")?,
                status_4xx: row.try_get("status_4xx")?,
                status_5xx: row.try_get("status_5xx")?,
                status_other: row.try_get("status_other")?,
            },
        );
    }

    let buckets = win
        .buckets
        .into_iter()
        .map(|(dt, label)| {
            let mut rule_counts = BTreeMap::new();
            if let Some(entries) = bucket_rule_raw.remove(&dt) {
                for (rule_id, cnt) in entries {
                    let key = if top_rules.contains(&rule_id) {
                        rule_id
                    } else {
                        "其他".to_string()
                    };
                    *rule_counts.entry(key).or_insert(0) += cnt;
                }
            }
            let counts = status_map.remove(&dt).unwrap_or_default();
            RoutingBucket {
                label,
                rule_counts,
                first_try_success: counts.first_try_success,
                retry_success: counts.retry_success,
                final_error: counts.final_error,
                status_2xx: counts.status_2xx,
                status_4xx: counts.status_4xx,
                status_5xx: counts.status_5xx,
                status_other: counts.status_other,
            }
        })
        .collect();

    let provider_rows = sqlx::query(
        r"
        SELECT
            provider_id,
            MAX(provider_name) AS provider_name,
            COUNT(*)::BIGINT AS request_count,
            COUNT(*) FILTER (WHERE status_code >= 200 AND status_code < 400)::BIGINT AS ok_count,
            COUNT(*) FILTER (WHERE status_code >= 400 OR status_code < 200)::BIGINT AS error_count
        FROM request_logs
        WHERE created_at >= $1
          AND ($2::TEXT IS NULL OR project_id = $2)
          AND ($3::TEXT IS NULL OR provider_id = $3)
          AND ($4::TEXT IS NULL OR model_id = $4)
        GROUP BY provider_id
        ORDER BY request_count DESC
        LIMIT 12
        ",
    )
    .bind(win.start_utc)
    .bind(filter.project_id)
    .bind(filter.provider_id)
    .bind(filter.model_id)
    .fetch_all(pool)
    .await?;

    let mut provider_stats = Vec::with_capacity(provider_rows.len());
    for row in provider_rows {
        let req_count: i64 = row.try_get("request_count")?;
        let ok_count: i64 = row.try_get("ok_count")?;
        #[allow(clippy::cast_precision_loss)]
        let success_rate = if req_count > 0 {
            (ok_count as f64) * 100.0 / (req_count as f64)
        } else {
            0.0
        };
        provider_stats.push(ProviderRoutingStat {
            provider_id: row.try_get("provider_id")?,
            provider_name: row.try_get("provider_name")?,
            request_count: req_count,
            success_rate,
            error_count: row.try_get("error_count")?,
        });
    }

    let reason_rows = sqlx::query(
        r"
        SELECT
            COALESCE(NULLIF(LOWER(TRIM(finish_reason)), ''), 'other') AS reason,
            COUNT(*)::BIGINT AS cnt
        FROM request_logs
        WHERE created_at >= $1
          AND ($2::TEXT IS NULL OR project_id = $2)
          AND ($3::TEXT IS NULL OR provider_id = $3)
          AND ($4::TEXT IS NULL OR model_id = $4)
        GROUP BY reason
        ORDER BY cnt DESC
        ",
    )
    .bind(win.start_utc)
    .bind(filter.project_id)
    .bind(filter.provider_id)
    .bind(filter.model_id)
    .fetch_all(pool)
    .await?;

    let mut finish_map: BTreeMap<String, i64> = BTreeMap::new();
    for row in reason_rows {
        let raw: String = row.try_get("reason")?;
        let cnt: i64 = row.try_get("cnt")?;
        let bucket = match raw.as_str() {
            "stop" | "length" | "tool_calls" | "error" => raw,
            _ => "other".to_string(),
        };
        *finish_map.entry(bucket).or_insert(0) += cnt;
    }
    let finish_reasons = finish_map
        .into_iter()
        .map(|(name, count)| NamedCount { name, count })
        .collect();

    let stream_row = sqlx::query(
        r"
        SELECT
            COUNT(*) FILTER (WHERE is_stream)::BIGINT AS stream_count,
            COUNT(*) FILTER (WHERE NOT is_stream)::BIGINT AS non_stream_count
        FROM request_logs
        WHERE created_at >= $1
          AND ($2::TEXT IS NULL OR project_id = $2)
          AND ($3::TEXT IS NULL OR provider_id = $3)
          AND ($4::TEXT IS NULL OR model_id = $4)
        ",
    )
    .bind(win.start_utc)
    .bind(filter.project_id)
    .bind(filter.provider_id)
    .bind(filter.model_id)
    .fetch_one(pool)
    .await?;

    let stream_split = StreamSplit {
        stream_count: stream_row.try_get("stream_count")?,
        non_stream_count: stream_row.try_get("non_stream_count")?,
    };

    let rule_stat_rows = sqlx::query(
        r"
        SELECT
            route_rule_id,
            COUNT(*)::BIGINT AS request_count,
            COUNT(DISTINCT provider_id || '/' || model_id)::BIGINT AS endpoint_count,
            COUNT(*) FILTER (WHERE attempt_index = 1 AND status_code >= 200 AND status_code < 400)::BIGINT AS first_try_ok,
            COUNT(*) FILTER (WHERE attempt_index > 1)::BIGINT AS fallback_cnt,
            COALESCE(AVG(routing_ms) FILTER (WHERE routing_ms > 0), 0)::DOUBLE PRECISION AS avg_routing_ms,
            COALESCE(AVG(total_duration_ms), 0)::DOUBLE PRECISION AS avg_duration_ms
        FROM request_logs
        WHERE created_at >= $1
          AND ($2::TEXT IS NULL OR project_id = $2)
          AND ($3::TEXT IS NULL OR provider_id = $3)
          AND ($4::TEXT IS NULL OR model_id = $4)
        GROUP BY route_rule_id
        ORDER BY request_count DESC
        LIMIT 25
        ",
    )
    .bind(win.start_utc)
    .bind(filter.project_id)
    .bind(filter.provider_id)
    .bind(filter.model_id)
    .fetch_all(pool)
    .await?;

    let sum_row = sqlx::query(
        r"
        SELECT
            COUNT(*)::BIGINT AS total_requests,
            COUNT(*) FILTER (WHERE attempt_index = 1 AND status_code >= 200 AND status_code < 400)::BIGINT AS first_try_ok,
            COUNT(*) FILTER (WHERE attempt_index > 1 AND status_code >= 200 AND status_code < 400)::BIGINT AS retry_ok,
            COUNT(*) FILTER (WHERE attempt_index > 1)::BIGINT AS retry_total
        FROM request_logs
        WHERE created_at >= $1
          AND ($2::TEXT IS NULL OR project_id = $2)
          AND ($3::TEXT IS NULL OR provider_id = $3)
          AND ($4::TEXT IS NULL OR model_id = $4)
        ",
    )
    .bind(win.start_utc)
    .bind(filter.project_id)
    .bind(filter.provider_id)
    .bind(filter.model_id)
    .fetch_one(pool)
    .await?;

    let total_reqs: i64 = sum_row.try_get("total_requests")?;
    let first_try_ok: i64 = sum_row.try_get("first_try_ok")?;
    let retry_ok: i64 = sum_row.try_get("retry_ok")?;
    let retry_total: i64 = sum_row.try_get("retry_total")?;
    let stream_tot = stream_split.stream_count + stream_split.non_stream_count;

    #[allow(clippy::cast_precision_loss)]
    let summary = RoutingSummary {
        active_rules: i64::try_from(rule_stat_rows.len()).unwrap_or(0),
        first_try_success_rate: if total_reqs > 0 {
            (first_try_ok as f64) * 100.0 / (total_reqs as f64)
        } else {
            0.0
        },
        retry_success_count: retry_ok,
        retry_recovery_rate: if retry_total > 0 {
            (retry_ok as f64) * 100.0 / (retry_total as f64)
        } else {
            0.0
        },
        stream_rate: if stream_tot > 0 {
            (stream_split.stream_count as f64) * 100.0 / (stream_tot as f64)
        } else {
            0.0
        },
    };

    let mut rule_stats = Vec::with_capacity(rule_stat_rows.len());
    for row in rule_stat_rows {
        let reqs: i64 = row.try_get("request_count")?;
        let f_ok: i64 = row.try_get("first_try_ok")?;
        let fb_cnt: i64 = row.try_get("fallback_cnt")?;
        #[allow(clippy::cast_precision_loss)]
        rule_stats.push(RouteRuleStat {
            rule_id: row.try_get("route_rule_id")?,
            request_count: reqs,
            share_percent: if total_reqs > 0 {
                (reqs as f64) * 100.0 / (total_reqs as f64)
            } else {
                0.0
            },
            endpoint_count: row.try_get("endpoint_count")?,
            first_try_rate: if reqs > 0 {
                (f_ok as f64) * 100.0 / (reqs as f64)
            } else {
                0.0
            },
            fallback_rate: if reqs > 0 {
                (fb_cnt as f64) * 100.0 / (reqs as f64)
            } else {
                0.0
            },
            avg_routing_ms: row.try_get("avg_routing_ms")?,
            avg_duration_ms: row.try_get("avg_duration_ms")?,
        });
    }

    let attempt_row = sqlx::query(
        r"
        SELECT
            COUNT(*) FILTER (WHERE attempt_index <= 1)::BIGINT AS a1,
            COUNT(*) FILTER (WHERE attempt_index = 2)::BIGINT AS a2,
            COUNT(*) FILTER (WHERE attempt_index >= 3)::BIGINT AS a3
        FROM request_logs
        WHERE created_at >= $1
          AND ($2::TEXT IS NULL OR project_id = $2)
          AND ($3::TEXT IS NULL OR provider_id = $3)
          AND ($4::TEXT IS NULL OR model_id = $4)
        ",
    )
    .bind(win.start_utc)
    .bind(filter.project_id)
    .bind(filter.provider_id)
    .bind(filter.model_id)
    .fetch_one(pool)
    .await?;

    let attempt_distribution = vec![
        NamedCount {
            name: "1次直连".to_string(),
            count: attempt_row.try_get("a1")?,
        },
        NamedCount {
            name: "2次尝试".to_string(),
            count: attempt_row.try_get("a2")?,
        },
        NamedCount {
            name: "3次+".to_string(),
            count: attempt_row.try_get("a3")?,
        },
    ];

    let mapping_rows = sqlx::query(
        r"
        SELECT
            call_model_id,
            provider_id,
            model_id,
            MAX(model_name) AS model_name,
            COUNT(*)::BIGINT AS request_count
        FROM request_logs
        WHERE created_at >= $1
          AND ($2::TEXT IS NULL OR project_id = $2)
          AND ($3::TEXT IS NULL OR provider_id = $3)
          AND ($4::TEXT IS NULL OR model_id = $4)
        GROUP BY call_model_id, provider_id, model_id
        ORDER BY request_count DESC
        LIMIT 10
        ",
    )
    .bind(win.start_utc)
    .bind(filter.project_id)
    .bind(filter.provider_id)
    .bind(filter.model_id)
    .fetch_all(pool)
    .await?;

    let mut call_model_mappings = Vec::with_capacity(mapping_rows.len());
    for row in mapping_rows {
        call_model_mappings.push(CallModelMappingStat {
            call_model_id: row.try_get("call_model_id")?,
            provider_id: row.try_get("provider_id")?,
            model_id: row.try_get("model_id")?,
            model_name: row.try_get("model_name")?,
            request_count: row.try_get("request_count")?,
        });
    }

    let source_rows = sqlx::query(
        r"
        SELECT token_source AS name, COUNT(*)::BIGINT AS count
        FROM request_logs
        WHERE created_at >= $1
          AND ($2::TEXT IS NULL OR project_id = $2)
          AND ($3::TEXT IS NULL OR provider_id = $3)
          AND ($4::TEXT IS NULL OR model_id = $4)
        GROUP BY token_source
        ORDER BY count DESC
        ",
    )
    .bind(win.start_utc)
    .bind(filter.project_id)
    .bind(filter.provider_id)
    .bind(filter.model_id)
    .fetch_all(pool)
    .await?;

    let mut token_sources = Vec::with_capacity(source_rows.len());
    for row in source_rows {
        token_sources.push(NamedCount {
            name: row.try_get("name")?,
            count: row.try_get("count")?,
        });
    }

    Ok(RoutingMonitoringResponse {
        meta,
        summary,
        rule_series_keys,
        buckets,
        rule_stats,
        provider_stats,
        finish_reasons,
        stream_split,
        attempt_distribution,
        call_model_mappings,
        token_sources,
    })
}

/// Queries the `errors` (异常) monitoring dimension.
///
/// # Errors
/// Returns an error if any PostgreSQL query fails.
#[allow(clippy::too_many_lines)]
pub async fn query_errors_monitoring(
    pool: &PgPool,
    catalog: &RuntimeCatalog,
    ui_cfg: &UiConfig,
    filter: &MonitoringFilter<'_>,
) -> Result<ErrorsMonitoringResponse> {
    let win = resolve_window(filter.range, filter.granularity, &ui_cfg.timezone);
    let meta = build_meta(catalog, ui_cfg, filter.range, filter.granularity);

    let rows = sqlx::query(
        r"
        SELECT
            date_trunc($1, created_at AT TIME ZONE 'UTC' + make_interval(secs => $2::int)) AS bucket,
            COUNT(*)::BIGINT AS total_requests,
            COUNT(*) FILTER (WHERE status_code >= 400 OR status_code < 200)::BIGINT AS error_count,
            COUNT(*) FILTER (WHERE status_code = 429)::BIGINT AS status_429,
            COUNT(*) FILTER (WHERE status_code >= 400 AND status_code < 500 AND status_code <> 429)::BIGINT AS status_4xx_other,
            COUNT(*) FILTER (WHERE status_code = 502)::BIGINT AS status_502,
            COUNT(*) FILTER (WHERE (status_code >= 500 AND status_code <> 502) OR status_code < 200)::BIGINT AS status_5xx_other,
            COALESCE(AVG(total_duration_ms) FILTER (WHERE status_code >= 400 OR status_code < 200), 0)::DOUBLE PRECISION AS avg_error_duration_ms,
            COUNT(*) FILTER (WHERE attempt_index > 1 AND status_code >= 200 AND status_code < 400)::BIGINT AS retry_recovered,
            COUNT(*) FILTER (WHERE status_code >= 400 OR status_code < 200)::BIGINT AS final_error,
            COUNT(*) FILTER (WHERE is_stream AND (status_code >= 400 OR token_source = 'fallback_estimated'))::BIGINT AS sse_interrupted
        FROM request_logs
        WHERE created_at >= $3
          AND ($4::TEXT IS NULL OR project_id = $4)
          AND ($5::TEXT IS NULL OR provider_id = $5)
          AND ($6::TEXT IS NULL OR model_id = $6)
        GROUP BY bucket
        ORDER BY bucket ASC
        ",
    )
    .bind(win.pg_unit)
    .bind(win.offset_secs)
    .bind(win.start_utc)
    .bind(filter.project_id)
    .bind(filter.provider_id)
    .bind(filter.model_id)
    .fetch_all(pool)
    .await?;

    let mut total_requests = 0i64;
    let mut total_errors = 0i64;
    let mut rate_limit_count = 0i64;
    let mut timeout_or_5xx_count = 0i64;
    let mut sse_interrupted_count = 0i64;
    let mut sum_4xx_other = 0i64;
    let mut sum_502 = 0i64;
    let mut sum_5xx_other = 0i64;

    let mut map: HashMap<NaiveDateTime, ErrorBucket> = HashMap::with_capacity(rows.len());
    for row in rows {
        let dt: NaiveDateTime = row.try_get("bucket")?;
        let tot: i64 = row.try_get("total_requests")?;
        let err: i64 = row.try_get("error_count")?;
        let s429: i64 = row.try_get("status_429")?;
        let s4o: i64 = row.try_get("status_4xx_other")?;
        let s502: i64 = row.try_get("status_502")?;
        let s5o: i64 = row.try_get("status_5xx_other")?;
        let sse_int: i64 = row.try_get("sse_interrupted")?;

        total_requests += tot;
        total_errors += err;
        rate_limit_count += s429;
        timeout_or_5xx_count += s502 + s5o;
        sse_interrupted_count += sse_int;
        sum_4xx_other += s4o;
        sum_502 += s502;
        sum_5xx_other += s5o;

        #[allow(clippy::cast_precision_loss)]
        let error_rate = if tot > 0 {
            (err as f64) * 100.0 / (tot as f64)
        } else {
            0.0
        };

        map.insert(
            dt,
            ErrorBucket {
                label: String::new(),
                total_requests: tot,
                error_count: err,
                error_rate,
                status_429: s429,
                status_4xx_other: s4o,
                status_502: s502,
                status_5xx_other: s5o,
                avg_error_duration_ms: row.try_get("avg_error_duration_ms")?,
                retry_recovered: row.try_get("retry_recovered")?,
                final_error: row.try_get("final_error")?,
            },
        );
    }

    let buckets = win
        .buckets
        .into_iter()
        .map(|(dt, label)| match map.remove(&dt) {
            Some(mut item) => {
                item.label = label;
                item
            }
            None => ErrorBucket {
                label,
                total_requests: 0,
                error_count: 0,
                error_rate: 0.0,
                status_429: 0,
                status_4xx_other: 0,
                status_502: 0,
                status_5xx_other: 0,
                avg_error_duration_ms: 0.0,
                retry_recovered: 0,
                final_error: 0,
            },
        })
        .collect();

    #[allow(clippy::cast_precision_loss)]
    let summary = ErrorsSummary {
        total_requests,
        total_errors,
        error_rate: if total_requests > 0 {
            (total_errors as f64) * 100.0 / (total_requests as f64)
        } else {
            0.0
        },
        rate_limit_count,
        rate_limit_rate: if total_requests > 0 {
            (rate_limit_count as f64) * 100.0 / (total_requests as f64)
        } else {
            0.0
        },
        timeout_or_5xx_count,
        timeout_or_5xx_rate: if total_requests > 0 {
            (timeout_or_5xx_count as f64) * 100.0 / (total_requests as f64)
        } else {
            0.0
        },
        sse_interrupted_count,
    };

    let detail_rows = sqlx::query(
        r"
        SELECT
            r.provider_id,
            MAX(r.provider_name) AS provider_name,
            r.model_id,
            MAX(r.model_name) AS model_name,
            r.route_rule_id,
            r.status_code,
            COALESCE(NULLIF(LEFT(TRIM(p.error_message), 160), ''), 'HTTP ' || r.status_code::text) AS error_snippet,
            COUNT(*)::BIGINT AS cnt,
            MAX(r.created_at) AS last_seen
        FROM request_logs r
        LEFT JOIN request_payloads p ON p.request_log_id = r.id
        WHERE r.created_at >= $1
          AND (r.status_code >= 400 OR r.status_code < 200)
          AND ($2::TEXT IS NULL OR r.project_id = $2)
          AND ($3::TEXT IS NULL OR r.provider_id = $3)
          AND ($4::TEXT IS NULL OR r.model_id = $4)
        GROUP BY r.provider_id, r.model_id, r.route_rule_id, r.status_code, error_snippet
        ORDER BY cnt DESC
        LIMIT 30
        ",
    )
    .bind(win.start_utc)
    .bind(filter.project_id)
    .bind(filter.provider_id)
    .bind(filter.model_id)
    .fetch_all(pool)
    .await?;

    let mut error_details = Vec::with_capacity(detail_rows.len());
    for row in detail_rows {
        let cnt: i64 = row.try_get("cnt")?;
        let last_seen: DateTime<Utc> = row.try_get("last_seen")?;
        #[allow(clippy::cast_precision_loss)]
        error_details.push(ErrorDetailRow {
            provider_id: row.try_get("provider_id")?,
            provider_name: row.try_get("provider_name")?,
            model_id: row.try_get("model_id")?,
            model_name: row.try_get("model_name")?,
            route_rule_id: row.try_get("route_rule_id")?,
            status_code: row.try_get("status_code")?,
            error_snippet: row.try_get("error_snippet")?,
            count: cnt,
            share_percent: if total_errors > 0 {
                (cnt as f64) * 100.0 / (total_errors as f64)
            } else {
                0.0
            },
            last_seen: last_seen.to_rfc3339(),
        });
    }

    let by_provider =
        query_error_entity_stats(pool, "provider_id", "provider_name", win.start_utc, filter)
            .await?;
    let by_model =
        query_error_entity_stats(pool, "model_id", "model_name", win.start_utc, filter).await?;
    let by_project =
        query_error_entity_stats(pool, "project_id", "project_name", win.start_utc, filter).await?;

    let status_breakdown = vec![
        NamedCount {
            name: "429 限流".to_string(),
            count: rate_limit_count,
        },
        NamedCount {
            name: "其他 4xx".to_string(),
            count: sum_4xx_other,
        },
        NamedCount {
            name: "502 网关/建连".to_string(),
            count: sum_502,
        },
        NamedCount {
            name: "其他 5xx".to_string(),
            count: sum_5xx_other,
        },
    ];

    Ok(ErrorsMonitoringResponse {
        meta,
        summary,
        buckets,
        error_details,
        by_provider,
        by_model,
        by_project,
        status_breakdown,
    })
}

/// Shared helper querying per-entity error counts and rates.
async fn query_error_entity_stats(
    pool: &PgPool,
    id_col: &str,
    name_col: &str,
    start_utc: DateTime<Utc>,
    filter: &MonitoringFilter<'_>,
) -> Result<Vec<ErrorEntityStat>> {
    let sql = format!(
        r"
        SELECT
            {id_col} AS id,
            MAX({name_col}) AS name,
            COUNT(*)::BIGINT AS total_requests,
            COUNT(*) FILTER (WHERE status_code >= 400 OR status_code < 200)::BIGINT AS error_count
        FROM request_logs
        WHERE created_at >= $1
          AND ($2::TEXT IS NULL OR project_id = $2)
          AND ($3::TEXT IS NULL OR provider_id = $3)
          AND ($4::TEXT IS NULL OR model_id = $4)
        GROUP BY {id_col}
        HAVING COUNT(*) FILTER (WHERE status_code >= 400 OR status_code < 200) > 0
        ORDER BY error_count DESC
        LIMIT 10
        "
    );
    let rows = sqlx::query(&sql)
        .bind(start_utc)
        .bind(filter.project_id)
        .bind(filter.provider_id)
        .bind(filter.model_id)
        .fetch_all(pool)
        .await?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let tot: i64 = row.try_get("total_requests")?;
        let err: i64 = row.try_get("error_count")?;
        #[allow(clippy::cast_precision_loss)]
        let error_rate = if tot > 0 {
            (err as f64) * 100.0 / (tot as f64)
        } else {
            0.0
        };
        out.push(ErrorEntityStat {
            id: row.try_get("id")?,
            name: row.try_get("name")?,
            total_requests: tot,
            error_count: err,
            error_rate,
        });
    }
    Ok(out)
}

/// Converts a per-currency `Decimal` map into an `f64` amount in the target currency.
fn convert_decimal_map(
    amounts: &BTreeMap<String, Decimal>,
    target_currency: Option<&str>,
    snapshot: Option<&RateSnapshot>,
) -> f64 {
    if amounts.is_empty() {
        return 0.0;
    }
    let converted = match target_currency {
        Some(target) => convert_totals(amounts, target, snapshot),
        None if amounts.len() == 1 => amounts.values().next().copied(),
        None => None,
    };
    converted.and_then(|d| d.to_f64()).unwrap_or(0.0)
}

/// Parses a `Decimal` string returned by PostgreSQL `NUMERIC::text`, defaulting to zero.
fn parse_decimal_or_zero(raw: &str) -> Decimal {
    Decimal::from_str(raw.trim()).unwrap_or(Decimal::ZERO)
}

/// Accumulates `Decimal` into a currency map safely.
fn add_currency_amount(map: &mut BTreeMap<String, Decimal>, currency: &str, amount: Decimal) {
    if amount <= Decimal::ZERO {
        return;
    }
    let entry = map.entry(currency.to_string()).or_default();
    if let Some(sum) = entry.checked_add(amount) {
        *entry = sum;
    }
}

/// Per-bucket mutable accumulator for cost queries.
#[derive(Default)]
struct CostBucketAcc {
    /// Total priced amounts per currency.
    total_currencies: BTreeMap<String, Decimal>,
    /// Per-model amounts per currency.
    by_model: HashMap<String, BTreeMap<String, Decimal>>,
    /// Per-project amounts per currency.
    by_project: HashMap<String, BTreeMap<String, Decimal>>,
    /// Input cost per currency.
    input_currencies: BTreeMap<String, Decimal>,
    /// Output cost per currency.
    output_currencies: BTreeMap<String, Decimal>,
    /// Cache read cost per currency.
    cache_read_currencies: BTreeMap<String, Decimal>,
    /// Cache write cost per currency.
    cache_write_currencies: BTreeMap<String, Decimal>,
    /// Other/miscellaneous cost per currency.
    other_currencies: BTreeMap<String, Decimal>,
    /// Count of priced requests.
    priced_requests: i64,
    /// Count of unpriced requests.
    unpriced_count: i64,
    /// Count of script errors.
    script_error_count: i64,
    /// Total tokens across priced requests.
    priced_tokens: i64,
}

/// Per-entity mutable accumulator for cost rankings and detail accounting.
#[derive(Default)]
struct CostRankAcc {
    /// Display name.
    name: String,
    /// Total amounts per currency.
    currencies: BTreeMap<String, Decimal>,
    /// Input component per currency.
    input_currencies: BTreeMap<String, Decimal>,
    /// Output component per currency.
    output_currencies: BTreeMap<String, Decimal>,
    /// Cache read+write component per currency.
    cache_currencies: BTreeMap<String, Decimal>,
    /// Other component per currency.
    other_currencies: BTreeMap<String, Decimal>,
    /// Unpriced requests.
    unpriced_count: i64,
    /// Total requests.
    request_count: i64,
    /// Total tokens across priced requests.
    priced_tokens: i64,
}

/// Queries the `cost` (成本) monitoring dimension.
///
/// # Errors
/// Returns an error if any PostgreSQL query fails.
#[allow(clippy::too_many_lines)]
pub async fn query_cost_monitoring(
    pool: &PgPool,
    catalog: &RuntimeCatalog,
    ui_cfg: &UiConfig,
    billing_cfg: &BillingConfig,
    filter: &MonitoringFilter<'_>,
) -> Result<CostMonitoringResponse> {
    let win = resolve_window(filter.range, filter.granularity, &ui_cfg.timezone);
    let meta = build_meta(catalog, ui_cfg, filter.range, filter.granularity);

    let fx_raw: Option<Value> =
        sqlx::query_scalar("SELECT billing_fx_rates FROM catalog_state WHERE singleton")
            .fetch_optional(pool)
            .await?
            .flatten();
    let snapshot: Option<RateSnapshot> = fx_raw.map(serde_json::from_value).transpose()?;

    let rows = sqlx::query(
        r"
        SELECT
            date_trunc($1, created_at AT TIME ZONE 'UTC' + make_interval(secs => $2::int)) AS bucket,
            project_id,
            MAX(project_name) AS project_name,
            provider_id,
            MAX(provider_name) AS provider_name,
            model_id,
            MAX(model_name) AS model_name,
            billing_currency,
            COALESCE(billing_status, 'unpriced') AS b_status,
            COUNT(*)::BIGINT AS row_count,
            COUNT(*) FILTER (WHERE billing_amount IS NOT NULL AND billing_currency IS NOT NULL)::BIGINT AS priced_count,
            COALESCE(SUM(total_tokens) FILTER (WHERE billing_amount IS NOT NULL AND billing_currency IS NOT NULL), 0)::BIGINT AS priced_tokens,
            COALESCE(SUM(billing_amount) FILTER (WHERE billing_amount IS NOT NULL AND billing_currency IS NOT NULL), 0)::text AS sum_amount,
            COALESCE(SUM(CASE WHEN billing_amount IS NOT NULL AND billing_currency IS NOT NULL AND billing_details->>'inputAmount' ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (billing_details->>'inputAmount')::numeric ELSE 0 END), 0)::text AS sum_input_amt,
            COALESCE(SUM(CASE WHEN billing_amount IS NOT NULL AND billing_currency IS NOT NULL AND billing_details->>'outputAmount' ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (billing_details->>'outputAmount')::numeric ELSE 0 END), 0)::text AS sum_output_amt,
            COALESCE(SUM(CASE WHEN billing_amount IS NOT NULL AND billing_currency IS NOT NULL AND billing_details->>'cacheReadAmount' ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (billing_details->>'cacheReadAmount')::numeric ELSE 0 END), 0)::text AS sum_cache_read_amt,
            COALESCE(SUM(CASE WHEN billing_amount IS NOT NULL AND billing_currency IS NOT NULL AND billing_details->>'cacheWriteAmount' ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (billing_details->>'cacheWriteAmount')::numeric ELSE 0 END), 0)::text AS sum_cache_write_amt,
            COALESCE(SUM(CASE WHEN billing_amount IS NOT NULL AND billing_currency IS NOT NULL AND billing_details->>'otherAmount' ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (billing_details->>'otherAmount')::numeric ELSE 0 END), 0)::text AS sum_other_amt
        FROM request_logs
        WHERE created_at >= $3
          AND ($4::TEXT IS NULL OR project_id = $4)
          AND ($5::TEXT IS NULL OR provider_id = $5)
          AND ($6::TEXT IS NULL OR model_id = $6)
        GROUP BY bucket, project_id, provider_id, model_id, billing_currency, COALESCE(billing_status, 'unpriced')
        ",
    )
    .bind(win.pg_unit)
    .bind(win.offset_secs)
    .bind(win.start_utc)
    .bind(filter.project_id)
    .bind(filter.provider_id)
    .bind(filter.model_id)
    .fetch_all(pool)
    .await?;

    let mut bucket_accs: HashMap<NaiveDateTime, CostBucketAcc> = HashMap::new();
    let mut model_ranks: HashMap<String, CostRankAcc> = HashMap::new();
    let mut project_ranks: HashMap<String, CostRankAcc> = HashMap::new();
    let mut provider_ranks: HashMap<String, CostRankAcc> = HashMap::new();
    let mut seen_currencies: BTreeSet<String> = BTreeSet::new();
    let mut raw_currency_totals: BTreeMap<String, Decimal> = BTreeMap::new();
    let mut status_counts_map: BTreeMap<String, i64> = BTreeMap::new();
    let mut total_input_cur: BTreeMap<String, Decimal> = BTreeMap::new();
    let mut total_output_cur: BTreeMap<String, Decimal> = BTreeMap::new();
    let mut total_cache_read_cur: BTreeMap<String, Decimal> = BTreeMap::new();
    let mut total_cache_write_cur: BTreeMap<String, Decimal> = BTreeMap::new();
    let mut total_other_cur: BTreeMap<String, Decimal> = BTreeMap::new();
    let mut total_priced_reqs = 0i64;
    let mut total_unpriced_reqs = 0i64;
    let mut total_script_errors = 0i64;
    let mut total_priced_tokens = 0i64;

    for row in rows {
        let dt: NaiveDateTime = row.try_get("bucket")?;
        let project_id: String = row.try_get("project_id")?;
        let project_name: String = row.try_get("project_name")?;
        let provider_id: String = row.try_get("provider_id")?;
        let provider_name: String = row.try_get("provider_name")?;
        let model_id: String = row.try_get("model_id")?;
        let model_name: String = row.try_get("model_name")?;
        let currency: Option<String> = row.try_get("billing_currency")?;
        let b_status: String = row.try_get("b_status")?;
        let row_count: i64 = row.try_get("row_count")?;
        let priced_count: i64 = row.try_get("priced_count")?;
        let priced_tokens: i64 = row.try_get("priced_tokens")?;
        let sum_amount_str: String = row.try_get("sum_amount")?;
        let sum_input_str: String = row.try_get("sum_input_amt")?;
        let sum_output_str: String = row.try_get("sum_output_amt")?;
        let sum_cache_read_str: String = row.try_get("sum_cache_read_amt")?;
        let sum_cache_write_str: String = row.try_get("sum_cache_write_amt")?;
        let sum_other_str: String = row.try_get("sum_other_amt")?;

        *status_counts_map.entry(b_status.clone()).or_insert(0) += row_count;

        let model_key = format!("{provider_id}/{model_id}");
        let acc = bucket_accs.entry(dt).or_default();
        let proj_acc = project_ranks
            .entry(project_id.clone())
            .or_insert_with(|| CostRankAcc {
                name: project_name,
                ..CostRankAcc::default()
            });
        let provider_acc = provider_ranks
            .entry(provider_id)
            .or_insert_with(|| CostRankAcc {
                name: provider_name,
                ..CostRankAcc::default()
            });
        let mod_acc = model_ranks
            .entry(model_key.clone())
            .or_insert_with(|| CostRankAcc {
                name: model_name,
                ..CostRankAcc::default()
            });
        proj_acc.request_count += row_count;
        provider_acc.request_count += row_count;
        mod_acc.request_count += row_count;

        if b_status == "script_error" {
            acc.script_error_count += row_count;
            total_script_errors += row_count;
        }

        let unpriced_in_group = row_count.saturating_sub(priced_count);
        if unpriced_in_group > 0 {
            acc.unpriced_count += unpriced_in_group;
            total_unpriced_reqs += unpriced_in_group;
            proj_acc.unpriced_count += unpriced_in_group;
            provider_acc.unpriced_count += unpriced_in_group;
            mod_acc.unpriced_count += unpriced_in_group;
        }

        if priced_count > 0
            && let Some(curr) = currency
        {
            let amt = parse_decimal_or_zero(&sum_amount_str);
            seen_currencies.insert(curr.clone());
            acc.priced_requests += priced_count;
            acc.priced_tokens += priced_tokens;
            total_priced_reqs += priced_count;
            total_priced_tokens += priced_tokens;
            proj_acc.priced_tokens += priced_tokens;
            provider_acc.priced_tokens += priced_tokens;
            mod_acc.priced_tokens += priced_tokens;

            add_currency_amount(&mut raw_currency_totals, &curr, amt);
            add_currency_amount(&mut acc.total_currencies, &curr, amt);
            add_currency_amount(acc.by_model.entry(model_key).or_default(), &curr, amt);
            add_currency_amount(acc.by_project.entry(project_id).or_default(), &curr, amt);
            add_currency_amount(&mut proj_acc.currencies, &curr, amt);
            add_currency_amount(&mut provider_acc.currencies, &curr, amt);
            add_currency_amount(&mut mod_acc.currencies, &curr, amt);

            let d_in = parse_decimal_or_zero(&sum_input_str);
            let d_out = parse_decimal_or_zero(&sum_output_str);
            let cache_read_amt = parse_decimal_or_zero(&sum_cache_read_str);
            let cache_write_amt = parse_decimal_or_zero(&sum_cache_write_str);
            let d_other = parse_decimal_or_zero(&sum_other_str);
            let d_cache = cache_read_amt
                .checked_add(cache_write_amt)
                .unwrap_or(cache_read_amt);

            add_currency_amount(&mut acc.input_currencies, &curr, d_in);
            add_currency_amount(&mut acc.output_currencies, &curr, d_out);
            add_currency_amount(&mut acc.cache_read_currencies, &curr, cache_read_amt);
            add_currency_amount(&mut acc.cache_write_currencies, &curr, cache_write_amt);
            add_currency_amount(&mut acc.other_currencies, &curr, d_other);

            add_currency_amount(&mut total_input_cur, &curr, d_in);
            add_currency_amount(&mut total_output_cur, &curr, d_out);
            add_currency_amount(&mut total_cache_read_cur, &curr, cache_read_amt);
            add_currency_amount(&mut total_cache_write_cur, &curr, cache_write_amt);
            add_currency_amount(&mut total_other_cur, &curr, d_other);

            for target in [&mut *proj_acc, &mut *provider_acc, &mut *mod_acc] {
                add_currency_amount(&mut target.input_currencies, &curr, d_in);
                add_currency_amount(&mut target.output_currencies, &curr, d_out);
                add_currency_amount(&mut target.cache_currencies, &curr, d_cache);
                add_currency_amount(&mut target.other_currencies, &curr, d_other);
            }
        }
    }

    let target_currency = billing_cfg.display_currency.as_deref().or_else(|| {
        (seen_currencies.len() == 1)
            .then(|| seen_currencies.iter().next().map(String::as_str))
            .flatten()
    });

    let mut rank_by_model = build_cost_ranks(&model_ranks, target_currency, snapshot.as_ref());
    let mut rank_by_project = build_cost_ranks(&project_ranks, target_currency, snapshot.as_ref());
    let mut rank_by_provider =
        build_cost_ranks(&provider_ranks, target_currency, snapshot.as_ref());

    let (top_keys, series_keys) = build_cost_series_keys(&rank_by_model);
    let (top_proj_keys, project_series_keys) = build_cost_series_keys(&rank_by_project);

    let buckets = win
        .buckets
        .into_iter()
        .map(|(dt, label)| {
            let Some(acc) = bucket_accs.remove(&dt) else {
                return CostBucket {
                    label,
                    total_amount: 0.0,
                    unpriced_count: 0,
                    script_error_count: 0,
                    by_model: BTreeMap::new(),
                    by_project: BTreeMap::new(),
                    input_amount: 0.0,
                    output_amount: 0.0,
                    cache_read_amount: 0.0,
                    cache_write_amount: 0.0,
                    other_amount: 0.0,
                    cost_per_1m_tokens: 0.0,
                    avg_cost_per_request: 0.0,
                };
            };
            let total_amount =
                convert_decimal_map(&acc.total_currencies, target_currency, snapshot.as_ref());
            let by_model =
                fold_cost_series(acc.by_model, &top_keys, target_currency, snapshot.as_ref());
            let by_project = fold_cost_series(
                acc.by_project,
                &top_proj_keys,
                target_currency,
                snapshot.as_ref(),
            );
            #[allow(clippy::cast_precision_loss)]
            let cost_per_1m_tokens = if acc.priced_tokens > 0 {
                total_amount * 1_000_000.0 / (acc.priced_tokens as f64)
            } else {
                0.0
            };
            #[allow(clippy::cast_precision_loss)]
            let avg_cost_per_request = if acc.priced_requests > 0 {
                total_amount / (acc.priced_requests as f64)
            } else {
                0.0
            };
            CostBucket {
                label,
                total_amount,
                unpriced_count: acc.unpriced_count,
                script_error_count: acc.script_error_count,
                by_model,
                by_project,
                input_amount: convert_decimal_map(
                    &acc.input_currencies,
                    target_currency,
                    snapshot.as_ref(),
                ),
                output_amount: convert_decimal_map(
                    &acc.output_currencies,
                    target_currency,
                    snapshot.as_ref(),
                ),
                cache_read_amount: convert_decimal_map(
                    &acc.cache_read_currencies,
                    target_currency,
                    snapshot.as_ref(),
                ),
                cache_write_amount: convert_decimal_map(
                    &acc.cache_write_currencies,
                    target_currency,
                    snapshot.as_ref(),
                ),
                other_amount: convert_decimal_map(
                    &acc.other_currencies,
                    target_currency,
                    snapshot.as_ref(),
                ),
                cost_per_1m_tokens,
                avg_cost_per_request,
            }
        })
        .collect();

    let total_amount =
        convert_decimal_map(&raw_currency_totals, target_currency, snapshot.as_ref());
    let total_reqs_all = total_priced_reqs + total_unpriced_reqs;
    #[allow(clippy::cast_precision_loss)]
    let summary = CostSummary {
        total_amount,
        cost_per_1m_tokens: if total_priced_tokens > 0 {
            total_amount * 1_000_000.0 / (total_priced_tokens as f64)
        } else {
            0.0
        },
        avg_cost_per_request: if total_priced_reqs > 0 {
            total_amount / (total_priced_reqs as f64)
        } else {
            0.0
        },
        priced_count: total_priced_reqs,
        unpriced_count: total_unpriced_reqs,
        script_error_count: total_script_errors,
        coverage_rate: if total_reqs_all > 0 {
            (total_priced_reqs as f64) * 100.0 / (total_reqs_all as f64)
        } else {
            0.0
        },
        currency_totals: raw_currency_totals
            .into_iter()
            .filter_map(|(currency, dec)| {
                dec.to_f64()
                    .map(|amount| CurrencyTotal { currency, amount })
            })
            .collect(),
    };

    let component_totals = CostComponentTotals {
        input_amount: convert_decimal_map(&total_input_cur, target_currency, snapshot.as_ref()),
        output_amount: convert_decimal_map(&total_output_cur, target_currency, snapshot.as_ref()),
        cache_read_amount: convert_decimal_map(
            &total_cache_read_cur,
            target_currency,
            snapshot.as_ref(),
        ),
        cache_write_amount: convert_decimal_map(
            &total_cache_write_cur,
            target_currency,
            snapshot.as_ref(),
        ),
        other_amount: convert_decimal_map(&total_other_cur, target_currency, snapshot.as_ref()),
    };

    let billing_status_counts = status_counts_map
        .into_iter()
        .map(|(name, count)| NamedCount { name, count })
        .collect();

    let mut detail_rows = Vec::new();
    append_cost_details(
        &mut detail_rows,
        "model",
        &model_ranks,
        target_currency,
        snapshot.as_ref(),
    );
    append_cost_details(
        &mut detail_rows,
        "project",
        &project_ranks,
        target_currency,
        snapshot.as_ref(),
    );
    append_cost_details(
        &mut detail_rows,
        "provider",
        &provider_ranks,
        target_currency,
        snapshot.as_ref(),
    );

    rank_by_model.truncate(10);
    rank_by_project.truncate(10);
    rank_by_provider.truncate(10);

    Ok(CostMonitoringResponse {
        meta,
        currency: target_currency.map(str::to_string),
        summary,
        component_totals,
        series_keys,
        project_series_keys,
        buckets,
        rank_by_project,
        rank_by_model,
        rank_by_provider,
        billing_status_counts,
        detail_rows,
    })
}

/// Converts a map of `CostRankAcc` into sorted `CostRankItem`s.
fn build_cost_ranks(
    map: &HashMap<String, CostRankAcc>,
    target_currency: Option<&str>,
    snapshot: Option<&RateSnapshot>,
) -> Vec<CostRankItem> {
    let mut out: Vec<CostRankItem> = map
        .iter()
        .map(|(id, acc)| CostRankItem {
            id: id.clone(),
            name: acc.name.clone(),
            amount: convert_decimal_map(&acc.currencies, target_currency, snapshot),
            unpriced_count: acc.unpriced_count,
            request_count: acc.request_count,
        })
        .collect();
    out.sort_by(|a, b| {
        b.amount
            .total_cmp(&a.amount)
            .then_with(|| b.request_count.cmp(&a.request_count))
    });
    out
}

/// Selects Top 5 series keys and optional `"__other__"` meta entry.
fn build_cost_series_keys(ranks: &[CostRankItem]) -> (BTreeSet<String>, Vec<CostSeriesMeta>) {
    let top_keys: BTreeSet<String> = ranks.iter().take(5).map(|i| i.id.clone()).collect();
    let mut series_keys: Vec<CostSeriesMeta> = ranks
        .iter()
        .take(5)
        .map(|i| CostSeriesMeta {
            key: i.id.clone(),
            name: i.name.clone(),
        })
        .collect();
    if ranks.len() > 5 {
        series_keys.push(CostSeriesMeta {
            key: "__other__".to_string(),
            name: "其他".to_string(),
        });
    }
    (top_keys, series_keys)
}

/// Folds per-entity currency maps into Top 5 + `"__other__"` float values.
fn fold_cost_series(
    raw: HashMap<String, BTreeMap<String, Decimal>>,
    top_keys: &BTreeSet<String>,
    target_currency: Option<&str>,
    snapshot: Option<&RateSnapshot>,
) -> BTreeMap<String, f64> {
    let mut out = BTreeMap::new();
    for (k, curr_map) in raw {
        let target_k = if top_keys.contains(&k) {
            k
        } else {
            "__other__".to_string()
        };
        let val = convert_decimal_map(&curr_map, target_currency, snapshot);
        *out.entry(target_k).or_insert(0.0) += val;
    }
    out
}

/// Appends sorted `CostDetailRow` entries for one grouping dimension.
fn append_cost_details(
    out: &mut Vec<CostDetailRow>,
    group_by: &str,
    map: &HashMap<String, CostRankAcc>,
    target_currency: Option<&str>,
    snapshot: Option<&RateSnapshot>,
) {
    let mut rows: Vec<CostDetailRow> = map
        .iter()
        .map(|(id, acc)| {
            let total_amount = convert_decimal_map(&acc.currencies, target_currency, snapshot);
            #[allow(clippy::cast_precision_loss)]
            let cost_per_1m_tokens = if acc.priced_tokens > 0 {
                total_amount * 1_000_000.0 / (acc.priced_tokens as f64)
            } else {
                0.0
            };
            CostDetailRow {
                group_by: group_by.to_string(),
                id: id.clone(),
                name: acc.name.clone(),
                total_amount,
                share_percent: 0.0,
                input_amount: convert_decimal_map(&acc.input_currencies, target_currency, snapshot),
                output_amount: convert_decimal_map(
                    &acc.output_currencies,
                    target_currency,
                    snapshot,
                ),
                cache_amount: convert_decimal_map(&acc.cache_currencies, target_currency, snapshot),
                other_amount: convert_decimal_map(&acc.other_currencies, target_currency, snapshot),
                cost_per_1m_tokens,
                request_count: acc.request_count,
                unpriced_count: acc.unpriced_count,
            }
        })
        .collect();

    let dim_total: f64 = rows.iter().map(|r| r.total_amount).sum();
    if dim_total > 0.0 {
        for r in &mut rows {
            r.share_percent = (r.total_amount * 100.0) / dim_total;
        }
    }
    rows.sort_by(|a, b| {
        b.total_amount
            .total_cmp(&a.total_amount)
            .then_with(|| b.request_count.cmp(&a.request_count))
    });
    rows.truncate(20);
    out.extend(rows);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_window_fills_expected_bucket_counts() {
        let win_1h = resolve_window("1h", "auto", "Asia/Shanghai");
        assert_eq!(win_1h.granularity, "minute");
        assert_eq!(win_1h.buckets.len(), 60);

        let win_24h = resolve_window("24h", "auto", "Asia/Shanghai");
        assert_eq!(win_24h.granularity, "hour");
        assert_eq!(win_24h.buckets.len(), 24);

        let month_win = resolve_window("30d", "auto", "Asia/Shanghai");
        assert_eq!(month_win.granularity, "day");
        assert_eq!(month_win.buckets.len(), 30);
    }

    #[test]
    fn top_n_slices_merges_tail_into_other() {
        let slices: Vec<UsageSlice> = (1..=8)
            .map(|i| UsageSlice {
                id: format!("m{i}"),
                name: format!("Model {i}"),
                total_tokens: i * 100,
                request_count: i,
            })
            .collect();
        let grouped = top_n_slices(slices, 6);
        assert_eq!(grouped.len(), 7);
        assert_eq!(grouped[0].id, "m8");
        assert_eq!(grouped[6].id, "__other__");
        assert_eq!(grouped[6].total_tokens, 300);
        assert_eq!(grouped[6].request_count, 3);
    }
}
