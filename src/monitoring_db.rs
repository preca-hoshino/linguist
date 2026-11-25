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
    CostBucket, CostMonitoringResponse, CostRankItem, CostSeriesMeta, FilterEntityItem,
    ModelPerformancePoint, MonitoringMeta, NamedCount, PerformanceBucket,
    PerformanceMonitoringResponse, ProviderRoutingStat, RoutingBucket, RoutingMonitoringResponse,
    StreamSplit, TrafficBucket, TrafficMonitoringResponse, UsageSlice,
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

    TimeWindow {
        range_key: range_key.to_string(),
        granularity: resolved_gran,
        pg_unit,
        start_utc,
        offset_secs,
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

/// Queries the `traffic` monitoring dimension.
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
            COALESCE(SUM(reasoning_tokens), 0)::BIGINT AS reasoning_tokens
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

    let mut map: HashMap<NaiveDateTime, TrafficBucket> = HashMap::with_capacity(rows.len());
    for row in rows {
        let bucket_dt: NaiveDateTime = row.try_get("bucket")?;
        let input_tokens: i64 = row.try_get("input_tokens")?;
        let cache_read_tokens: i64 = row.try_get("cache_read_tokens")?;
        let denom = input_tokens + cache_read_tokens;
        #[allow(clippy::cast_precision_loss)]
        let cache_hit_rate = if denom > 0 {
            ((cache_read_tokens as f64) * 100.0 / (denom as f64)).min(100.0)
        } else {
            0.0
        };
        map.insert(
            bucket_dt,
            TrafficBucket {
                label: String::new(),
                total_requests: row.try_get("total_requests")?,
                success_requests: row.try_get("success_requests")?,
                error_requests: row.try_get("error_requests")?,
                input_tokens,
                output_tokens: row.try_get("output_tokens")?,
                cache_read_tokens,
                cache_creation_tokens: row.try_get("cache_creation_tokens")?,
                reasoning_tokens: row.try_get("reasoning_tokens")?,
                cache_hit_rate,
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
            None => TrafficBucket {
                label,
                total_requests: 0,
                success_requests: 0,
                error_requests: 0,
                input_tokens: 0,
                output_tokens: 0,
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
                reasoning_tokens: 0,
                cache_hit_rate: 0.0,
            },
        })
        .collect();

    let model_rows = sqlx::query(
        r"
        SELECT
            model_id AS id,
            MAX(model_name) AS name,
            COALESCE(SUM(total_tokens), 0)::BIGINT AS total_tokens,
            COUNT(*)::BIGINT AS request_count
        FROM request_logs
        WHERE created_at >= $1
          AND ($2::TEXT IS NULL OR project_id = $2)
          AND ($3::TEXT IS NULL OR provider_id = $3)
          AND ($4::TEXT IS NULL OR model_id = $4)
        GROUP BY model_id
        ",
    )
    .bind(win.start_utc)
    .bind(filter.project_id)
    .bind(filter.provider_id)
    .bind(filter.model_id)
    .fetch_all(pool)
    .await?;

    let mut by_model = Vec::with_capacity(model_rows.len());
    for row in model_rows {
        by_model.push(UsageSlice {
            id: row.try_get("id")?,
            name: row.try_get("name")?,
            total_tokens: row.try_get("total_tokens")?,
            request_count: row.try_get("request_count")?,
        });
    }

    let project_rows = sqlx::query(
        r"
        SELECT
            project_id AS id,
            MAX(project_name) AS name,
            COALESCE(SUM(total_tokens), 0)::BIGINT AS total_tokens,
            COUNT(*)::BIGINT AS request_count
        FROM request_logs
        WHERE created_at >= $1
          AND ($2::TEXT IS NULL OR project_id = $2)
          AND ($3::TEXT IS NULL OR provider_id = $3)
          AND ($4::TEXT IS NULL OR model_id = $4)
        GROUP BY project_id
        ",
    )
    .bind(win.start_utc)
    .bind(filter.project_id)
    .bind(filter.provider_id)
    .bind(filter.model_id)
    .fetch_all(pool)
    .await?;

    let mut by_project = Vec::with_capacity(project_rows.len());
    for row in project_rows {
        by_project.push(UsageSlice {
            id: row.try_get("id")?,
            name: row.try_get("name")?,
            total_tokens: row.try_get("total_tokens")?,
            request_count: row.try_get("request_count")?,
        });
    }

    Ok(TrafficMonitoringResponse {
        meta,
        buckets,
        distribution_by_model: top_n_slices(by_model, 6),
        distribution_by_project: top_n_slices(by_project, 6),
    })
}

/// Queries the `performance` monitoring dimension.
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
            COALESCE(AVG(e2e_tps) FILTER (WHERE e2e_tps > 0), 0)::DOUBLE PRECISION AS avg_e2e_tps
        FROM request_logs
        WHERE created_at >= $3
          AND status_code >= 200 AND status_code < 400
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
                avg_e2e_tps: row.try_get("avg_e2e_tps")?,
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
                avg_e2e_tps: 0.0,
            },
        })
        .collect();

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
        GROUP BY provider_id, model_id
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

    Ok(PerformanceMonitoringResponse {
        meta,
        buckets,
        model_quadrant,
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

    Ok(RoutingMonitoringResponse {
        meta,
        rule_series_keys,
        buckets,
        provider_stats,
        finish_reasons,
        stream_split,
    })
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

/// Extracts a decimal string field from `billing_details` JSONB.
fn json_decimal(details: &Value, key: &str) -> Decimal {
    details
        .get(key)
        .and_then(Value::as_str)
        .and_then(|s| Decimal::from_str(s).ok())
        .unwrap_or(Decimal::ZERO)
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
    /// Total tokens across priced requests.
    priced_tokens: i64,
}

/// Per-entity mutable accumulator for cost rankings.
#[derive(Default)]
struct CostRankAcc {
    /// Display name.
    name: String,
    /// Total amounts per currency.
    currencies: BTreeMap<String, Decimal>,
    /// Unpriced requests.
    unpriced_count: i64,
    /// Total requests.
    request_count: i64,
}

/// Queries the `cost` monitoring dimension.
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
            project_name,
            provider_id,
            model_id,
            model_name,
            total_tokens,
            billing_amount::text AS amount,
            billing_currency,
            billing_details
        FROM request_logs
        WHERE created_at >= $3
          AND ($4::TEXT IS NULL OR project_id = $4)
          AND ($5::TEXT IS NULL OR provider_id = $5)
          AND ($6::TEXT IS NULL OR model_id = $6)
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
    let mut seen_currencies: BTreeSet<String> = BTreeSet::new();

    for row in rows {
        let dt: NaiveDateTime = row.try_get("bucket")?;
        let project_id: String = row.try_get("project_id")?;
        let project_name: String = row.try_get("project_name")?;
        let provider_id: String = row.try_get("provider_id")?;
        let model_id: String = row.try_get("model_id")?;
        let model_name: String = row.try_get("model_name")?;
        let total_tokens: i64 = row.try_get("total_tokens")?;
        let amount_str: Option<String> = row.try_get("amount")?;
        let currency: Option<String> = row.try_get("billing_currency")?;
        let details: Option<Value> = row.try_get("billing_details")?;

        let model_key = format!("{provider_id}/{model_id}");
        let acc = bucket_accs.entry(dt).or_default();
        let proj_acc = project_ranks
            .entry(project_id)
            .or_insert_with(|| CostRankAcc {
                name: project_name,
                ..CostRankAcc::default()
            });
        let mod_acc = model_ranks
            .entry(model_key.clone())
            .or_insert_with(|| CostRankAcc {
                name: model_name,
                ..CostRankAcc::default()
            });
        proj_acc.request_count += 1;
        mod_acc.request_count += 1;

        if let (Some(amt_s), Some(curr)) = (amount_str, currency)
            && let Ok(amt) = Decimal::from_str(&amt_s)
        {
            seen_currencies.insert(curr.clone());
            acc.priced_requests += 1;
            acc.priced_tokens += total_tokens;
            add_currency_amount(&mut acc.total_currencies, &curr, amt);
            add_currency_amount(acc.by_model.entry(model_key).or_default(), &curr, amt);
            add_currency_amount(&mut proj_acc.currencies, &curr, amt);
            add_currency_amount(&mut mod_acc.currencies, &curr, amt);

            if let Some(det) = details {
                add_currency_amount(
                    &mut acc.input_currencies,
                    &curr,
                    json_decimal(&det, "inputAmount"),
                );
                add_currency_amount(
                    &mut acc.output_currencies,
                    &curr,
                    json_decimal(&det, "outputAmount"),
                );
                add_currency_amount(
                    &mut acc.cache_read_currencies,
                    &curr,
                    json_decimal(&det, "cacheReadAmount"),
                );
                add_currency_amount(
                    &mut acc.cache_write_currencies,
                    &curr,
                    json_decimal(&det, "cacheWriteAmount"),
                );
                add_currency_amount(
                    &mut acc.other_currencies,
                    &curr,
                    json_decimal(&det, "otherAmount"),
                );
            }
        } else {
            acc.unpriced_count += 1;
            proj_acc.unpriced_count += 1;
            mod_acc.unpriced_count += 1;
        }
    }

    let target_currency = billing_cfg.display_currency.as_deref().or_else(|| {
        (seen_currencies.len() == 1)
            .then(|| seen_currencies.iter().next().map(String::as_str))
            .flatten()
    });

    let mut rank_by_model: Vec<CostRankItem> = model_ranks
        .into_iter()
        .map(|(id, acc)| CostRankItem {
            id,
            name: acc.name,
            amount: convert_decimal_map(&acc.currencies, target_currency, snapshot.as_ref()),
            unpriced_count: acc.unpriced_count,
            request_count: acc.request_count,
        })
        .collect();
    rank_by_model.sort_by(|a, b| {
        b.amount
            .total_cmp(&a.amount)
            .then_with(|| b.request_count.cmp(&a.request_count))
    });

    let mut rank_by_project: Vec<CostRankItem> = project_ranks
        .into_iter()
        .map(|(id, acc)| CostRankItem {
            id,
            name: acc.name,
            amount: convert_decimal_map(&acc.currencies, target_currency, snapshot.as_ref()),
            unpriced_count: acc.unpriced_count,
            request_count: acc.request_count,
        })
        .collect();
    rank_by_project.sort_by(|a, b| {
        b.amount
            .total_cmp(&a.amount)
            .then_with(|| b.request_count.cmp(&a.request_count))
    });

    let top_keys: BTreeSet<String> = rank_by_model
        .iter()
        .take(5)
        .map(|item| item.id.clone())
        .collect();
    let mut series_keys: Vec<CostSeriesMeta> = rank_by_model
        .iter()
        .take(5)
        .map(|item| CostSeriesMeta {
            key: item.id.clone(),
            name: item.name.clone(),
        })
        .collect();
    if rank_by_model.len() > 5 {
        series_keys.push(CostSeriesMeta {
            key: "__other__".to_string(),
            name: "其他".to_string(),
        });
    }

    let buckets = win
        .buckets
        .into_iter()
        .map(|(dt, label)| {
            let Some(acc) = bucket_accs.remove(&dt) else {
                return CostBucket {
                    label,
                    total_amount: 0.0,
                    unpriced_count: 0,
                    by_model: BTreeMap::new(),
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
            let mut by_model = BTreeMap::new();
            for (k, curr_map) in acc.by_model {
                let target_k = if top_keys.contains(&k) {
                    k
                } else {
                    "__other__".to_string()
                };
                let val = convert_decimal_map(&curr_map, target_currency, snapshot.as_ref());
                *by_model.entry(target_k).or_insert(0.0) += val;
            }
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
                by_model,
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

    rank_by_model.truncate(10);
    rank_by_project.truncate(10);

    Ok(CostMonitoringResponse {
        meta,
        currency: target_currency.map(str::to_string),
        series_keys,
        buckets,
        rank_by_project,
        rank_by_model,
    })
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
