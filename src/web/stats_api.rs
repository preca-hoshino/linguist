//! Read-only telemetry HTTP API endpoints (`/api/v1/stats/...`).

use axum::Json;
use axum::Router;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde::Deserialize;
use serde_json::json;

use crate::db;
use crate::models::{
    CostMonitoringResponse, FilterEntityItem, OverviewResponse, OverviewSummary,
    PerformanceMonitoringResponse, RoutingMonitoringResponse, StreamSplit,
    TrafficMonitoringResponse,
};
use crate::monitoring_db::{self, MonitoringFilter};
use crate::state::AppState;

/// Registers read-only telemetry API routes.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/stats/overview", get(overview_handler))
        .route("/api/v1/stats/leaderboard", get(leaderboard_handler))
        .route("/api/v1/stats/daily-models", get(daily_models_handler))
        .route(
            "/api/v1/stats/recent-requests",
            get(recent_requests_handler),
        )
        .route(
            "/api/v1/stats/monitoring/traffic",
            get(monitoring_traffic_handler),
        )
        .route(
            "/api/v1/stats/monitoring/performance",
            get(monitoring_performance_handler),
        )
        .route(
            "/api/v1/stats/monitoring/routing",
            get(monitoring_routing_handler),
        )
        .route(
            "/api/v1/stats/monitoring/cost",
            get(monitoring_cost_handler),
        )
}

/// Query parameters for `/api/v1/stats/overview`.
#[derive(Debug, Deserialize)]
struct OverviewQuery {
    /// Optional project filter.
    #[serde(default)]
    project_id: Option<String>,
    /// Optional provider filter.
    #[serde(default)]
    provider_id: Option<String>,
    /// Number of calendar days to include (default 365 for 53-week wall).
    #[serde(default)]
    days: Option<u32>,
}

/// Query parameters for `/api/v1/stats/leaderboard`.
#[derive(Debug, Deserialize)]
struct LeaderboardQuery {
    /// Optional project filter.
    #[serde(default)]
    project_id: Option<String>,
    /// Optional provider filter.
    #[serde(default)]
    provider_id: Option<String>,
    /// Time window in days (`None` or `0` = all time).
    #[serde(default)]
    days: Option<u32>,
    /// Sort column (`avg_decode_tps`, `p50_decode_tps`, `p90_decode_tps`, `avg_ttft_ms`).
    #[serde(default)]
    sort: Option<String>,
}

/// Query parameters for `/api/v1/stats/daily-models`.
#[derive(Debug, Deserialize)]
struct DailyModelsQuery {
    /// Optional project filter.
    #[serde(default)]
    project_id: Option<String>,
    /// Optional provider filter.
    #[serde(default)]
    provider_id: Option<String>,
    /// Number of days to return (7, 14, 30, 90).
    #[serde(default)]
    days: Option<u32>,
}

/// Query parameters for `/api/v1/stats/recent-requests`.
#[derive(Debug, Deserialize)]
struct RecentRequestsQuery {
    /// Optional project filter.
    #[serde(default)]
    project_id: Option<String>,
    /// Optional provider filter.
    #[serde(default)]
    provider_id: Option<String>,
    /// Optional model filter.
    #[serde(default)]
    model_id: Option<String>,
    /// Maximum rows returned (default 50, max 200).
    #[serde(default)]
    limit: Option<u32>,
}

/// Normalizes empty strings to `None`.
fn clean_opt(val: Option<&str>) -> Option<&str> {
    val.map(str::trim).filter(|s| !s.is_empty())
}

/// `GET /api/v1/stats/overview` handler.
async fn overview_handler(
    State(state): State<AppState>,
    Query(query): Query<OverviewQuery>,
) -> Response {
    let catalog = state.catalog.load();
    let Some(pool) = &state.db_pool else {
        return Json(OverviewResponse {
            title: state.config.ui.title.clone(),
            timezone: state.config.ui.timezone.clone(),
            projects: catalog
                .projects
                .iter()
                .map(|p| FilterEntityItem {
                    id: p.id.clone(),
                    name: p.name.clone(),
                    icon: p.icon.clone(),
                })
                .collect(),
            providers: catalog
                .providers
                .iter()
                .map(|p| FilterEntityItem {
                    id: p.id.clone(),
                    name: p.name.clone(),
                    icon: p.icon.clone(),
                })
                .collect(),
            summary: OverviewSummary {
                total_tokens: 0,
                input_tokens: 0,
                output_tokens: 0,
                cache_read_tokens: 0,
                cache_hit_rate: 0.0,
                total_requests: 0,
                active_streak_days: 0,
                top_model: None,
            },
            days: Vec::new(),
        })
        .into_response();
    };

    let days = query.days.unwrap_or(365);
    match db::query_overview(
        pool,
        &catalog,
        &state.config.ui,
        clean_opt(query.project_id.as_deref()),
        clean_opt(query.provider_id.as_deref()),
        days,
    )
    .await
    {
        Ok(resp) => Json(resp).into_response(),
        Err(err) => db_error_response(&err),
    }
}

/// `GET /api/v1/stats/leaderboard` handler.
async fn leaderboard_handler(
    State(state): State<AppState>,
    Query(query): Query<LeaderboardQuery>,
) -> Response {
    let Some(pool) = &state.db_pool else {
        return Json(json!([])).into_response();
    };
    let catalog = state.catalog.load();
    let days = query.days.filter(|&d| d > 0);
    let sort = query.sort.as_deref().unwrap_or("avg_decode_tps");

    match db::query_leaderboard(
        pool,
        &catalog,
        clean_opt(query.project_id.as_deref()),
        clean_opt(query.provider_id.as_deref()),
        days,
        sort,
        state.config.ui.leaderboard_min_requests,
    )
    .await
    {
        Ok(items) => Json(items).into_response(),
        Err(err) => db_error_response(&err),
    }
}

/// `GET /api/v1/stats/daily-models` handler.
async fn daily_models_handler(
    State(state): State<AppState>,
    Query(query): Query<DailyModelsQuery>,
) -> Response {
    let Some(pool) = &state.db_pool else {
        return Json(json!([])).into_response();
    };
    let days = query.days.unwrap_or(state.config.ui.default_days_range);

    match db::query_daily_models(
        pool,
        &state.config.ui,
        clean_opt(query.project_id.as_deref()),
        clean_opt(query.provider_id.as_deref()),
        days,
    )
    .await
    {
        Ok(days_data) => Json(days_data).into_response(),
        Err(err) => db_error_response(&err),
    }
}

/// `GET /api/v1/stats/recent-requests` handler.
async fn recent_requests_handler(
    State(state): State<AppState>,
    Query(query): Query<RecentRequestsQuery>,
) -> Response {
    let Some(pool) = &state.db_pool else {
        return Json(json!([])).into_response();
    };
    let catalog = state.catalog.load();
    let limit = query.limit.unwrap_or(50);

    match db::query_recent_requests(
        pool,
        &catalog,
        clean_opt(query.project_id.as_deref()),
        clean_opt(query.provider_id.as_deref()),
        clean_opt(query.model_id.as_deref()),
        limit,
    )
    .await
    {
        Ok(rows) => Json(rows).into_response(),
        Err(err) => db_error_response(&err),
    }
}

/// Query parameters for `/api/v1/stats/monitoring/*`.
#[derive(Debug, Deserialize)]
struct MonitoringQuery {
    /// Time range (`1h`, `6h`, `24h`, `7d`, `30d`, `90d`).
    #[serde(default)]
    range: Option<String>,
    /// Bucket granularity (`auto`, `minute`, `hour`, `day`).
    #[serde(default)]
    granularity: Option<String>,
    /// Optional project filter.
    #[serde(default)]
    project_id: Option<String>,
    /// Optional provider filter.
    #[serde(default)]
    provider_id: Option<String>,
    /// Optional model filter.
    #[serde(default)]
    model_id: Option<String>,
}

/// Normalizes `MonitoringQuery` into a `MonitoringFilter`.
fn as_monitoring_filter(query: &MonitoringQuery) -> MonitoringFilter<'_> {
    MonitoringFilter {
        range: clean_opt(query.range.as_deref()).unwrap_or("24h"),
        granularity: clean_opt(query.granularity.as_deref()).unwrap_or("auto"),
        project_id: clean_opt(query.project_id.as_deref()),
        provider_id: clean_opt(query.provider_id.as_deref()),
        model_id: clean_opt(query.model_id.as_deref()),
    }
}

/// `GET /api/v1/stats/monitoring/traffic` handler.
async fn monitoring_traffic_handler(
    State(state): State<AppState>,
    Query(query): Query<MonitoringQuery>,
) -> Response {
    let catalog = state.catalog.load();
    let filter = as_monitoring_filter(&query);
    let Some(pool) = &state.db_pool else {
        return Json(TrafficMonitoringResponse {
            meta: monitoring_db::build_meta(
                &catalog,
                &state.config.ui,
                filter.range,
                filter.granularity,
            ),
            buckets: Vec::new(),
            distribution_by_model: Vec::new(),
            distribution_by_project: Vec::new(),
        })
        .into_response();
    };
    match monitoring_db::query_traffic_monitoring(pool, &catalog, &state.config.ui, &filter).await {
        Ok(resp) => Json(resp).into_response(),
        Err(err) => db_error_response(&err),
    }
}

/// `GET /api/v1/stats/monitoring/performance` handler.
async fn monitoring_performance_handler(
    State(state): State<AppState>,
    Query(query): Query<MonitoringQuery>,
) -> Response {
    let catalog = state.catalog.load();
    let filter = as_monitoring_filter(&query);
    let Some(pool) = &state.db_pool else {
        return Json(PerformanceMonitoringResponse {
            meta: monitoring_db::build_meta(
                &catalog,
                &state.config.ui,
                filter.range,
                filter.granularity,
            ),
            buckets: Vec::new(),
            model_quadrant: Vec::new(),
        })
        .into_response();
    };
    match monitoring_db::query_performance_monitoring(pool, &catalog, &state.config.ui, &filter)
        .await
    {
        Ok(resp) => Json(resp).into_response(),
        Err(err) => db_error_response(&err),
    }
}

/// `GET /api/v1/stats/monitoring/routing` handler.
async fn monitoring_routing_handler(
    State(state): State<AppState>,
    Query(query): Query<MonitoringQuery>,
) -> Response {
    let catalog = state.catalog.load();
    let filter = as_monitoring_filter(&query);
    let Some(pool) = &state.db_pool else {
        return Json(RoutingMonitoringResponse {
            meta: monitoring_db::build_meta(
                &catalog,
                &state.config.ui,
                filter.range,
                filter.granularity,
            ),
            rule_series_keys: Vec::new(),
            buckets: Vec::new(),
            provider_stats: Vec::new(),
            finish_reasons: Vec::new(),
            stream_split: StreamSplit {
                stream_count: 0,
                non_stream_count: 0,
            },
        })
        .into_response();
    };
    match monitoring_db::query_routing_monitoring(pool, &catalog, &state.config.ui, &filter).await {
        Ok(resp) => Json(resp).into_response(),
        Err(err) => db_error_response(&err),
    }
}

/// `GET /api/v1/stats/monitoring/cost` handler.
async fn monitoring_cost_handler(
    State(state): State<AppState>,
    Query(query): Query<MonitoringQuery>,
) -> Response {
    let catalog = state.catalog.load();
    let filter = as_monitoring_filter(&query);
    let Some(pool) = &state.db_pool else {
        return Json(CostMonitoringResponse {
            meta: monitoring_db::build_meta(
                &catalog,
                &state.config.ui,
                filter.range,
                filter.granularity,
            ),
            currency: state.config.billing.display_currency.clone(),
            series_keys: Vec::new(),
            buckets: Vec::new(),
            rank_by_project: Vec::new(),
            rank_by_model: Vec::new(),
        })
        .into_response();
    };
    match monitoring_db::query_cost_monitoring(
        pool,
        &catalog,
        &state.config.ui,
        &state.config.billing,
        &filter,
    )
    .await
    {
        Ok(resp) => Json(resp).into_response(),
        Err(err) => db_error_response(&err),
    }
}

/// Formats a database query error as JSON HTTP 500.
fn db_error_response(err: &anyhow::Error) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": format!("database query error: {err}") })),
    )
        .into_response()
}
