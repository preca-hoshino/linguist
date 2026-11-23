//! Authenticated, read-only catalog endpoints.

use axum::extract::rejection::QueryRejection;
use axum::extract::{Path, Query, Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::middleware::{Next, from_fn_with_state};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use sqlx::PgPool;

use crate::catalog::postgres::catalog_status;
use crate::catalog::read::{self, Filters, Resource};
use crate::state::AppState;

/// Adds only GET/HEAD endpoints, independent of the model API's authentication and CORS.
pub(super) fn router(state: &AppState) -> Router<AppState> {
    Router::new()
        .route("/api/v1/catalog/status", get(status))
        .route("/api/v1/catalog/{resource}", get(list))
        .route("/api/v1/catalog/{resource}/detail", get(detail))
        .route_layer(from_fn_with_state(state.clone(), authorize))
}

/// Validates the configured console token before loading any catalog data.
async fn authorize(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let token = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split_once(' '))
        .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer"))
        .map_or("", |(_, token)| token.trim());
    let mut response = match state.verify_catalog_token(token) {
        None => error(StatusCode::SERVICE_UNAVAILABLE, "catalog_disabled"),
        Some(false) => {
            let mut response = error(StatusCode::UNAUTHORIZED, "unauthorized");
            response
                .headers_mut()
                .insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
            response
        }
        Some(true) => next.run(request).await,
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// Query parameters for lists and details, using query parameters for opaque IDs containing slashes.
#[derive(Debug, Deserialize)]
struct Parameters {
    /// Exact entry ID, required for detail queries.
    id: Option<String>,
    /// Search substring.
    q: Option<String>,
    /// One-indexed page.
    page: Option<i64>,
    /// Number of rows before the next-page probe.
    page_size: Option<i64>,
    /// Provider scope for upstream models.
    provider_id: Option<String>,
    /// Project scope for project models or routing.
    project_id: Option<String>,
    /// Call model to match in the routing table.
    call_model_id: Option<String>,
}

impl Parameters {
    /// Rejects malformed ranges, missing detail scope, and NUL strings before touching PostgreSQL.
    fn validate(&self, resource: Resource, is_detail: bool) -> bool {
        let text = [
            &self.id,
            &self.q,
            &self.provider_id,
            &self.project_id,
            &self.call_model_id,
        ];
        text.into_iter()
            .flatten()
            .all(|value| !value.contains('\0'))
            && self.q.as_ref().is_none_or(|q| q.chars().count() <= 200)
            && self.page.is_none_or(|p| (1..=100_000).contains(&p))
            && self.page_size.is_none_or(|n| (1..=100).contains(&n))
            && (!is_detail
                || (nonempty(self.id.as_deref())
                    && match resource {
                        Resource::ProviderModels => nonempty(self.provider_id.as_deref()),
                        Resource::ProjectModels => nonempty(self.project_id.as_deref()),
                        _ => true,
                    }))
    }

    /// Translates request parameters to explicitly scoped database filters.
    fn filters(&self, is_detail: bool, page: i64, size: i64) -> Filters<'_> {
        Filters {
            id: if is_detail { self.id.as_deref() } else { None },
            search: if is_detail {
                None
            } else {
                self.q.as_deref().map(str::trim).filter(|q| !q.is_empty())
            },
            provider: self.provider_id.as_deref().filter(|s| !s.is_empty()),
            project: self.project_id.as_deref().filter(|s| !s.is_empty()),
            call_model: self.call_model_id.as_deref().filter(|s| !s.is_empty()),
            limit: if is_detail { 1 } else { size + 1 },
            offset: if is_detail { 0 } else { (page - 1) * size },
        }
    }
}

/// Returns committed revision, the instance's loaded revision, and the importer result.
async fn status(State(state): State<AppState>) -> Response {
    let Some(pool) = &state.db_pool else {
        return unavailable();
    };
    match catalog_status(pool).await {
        Ok(status) => {
            let loaded = state.catalog.load().revision();
            let mut body = json!(status);
            body["loadedRevision"] = json!(loaded);
            Json(body).into_response()
        }
        Err(err) => database_error(&err),
    }
}

/// Returns a page of entries for the requested resource.
async fn list(
    State(state): State<AppState>,
    Path(resource): Path<String>,
    query: Result<Query<Parameters>, QueryRejection>,
) -> Response {
    let Some(pool) = &state.db_pool else {
        return unavailable();
    };
    fetch(pool, &resource, query, false).await
}

/// Returns the selected resource's form fields with credentials kept out of the response.
async fn detail(
    State(state): State<AppState>,
    Path(resource): Path<String>,
    query: Result<Query<Parameters>, QueryRejection>,
) -> Response {
    let Some(pool) = &state.db_pool else {
        return unavailable();
    };
    fetch(pool, &resource, query, true).await
}

/// Validates query and selects the appropriate list or detail envelope.
async fn fetch(
    pool: &PgPool,
    resource: &str,
    query: Result<Query<Parameters>, QueryRejection>,
    is_detail: bool,
) -> Response {
    let resource = match resource {
        "providers" => Resource::Providers,
        "provider-models" => Resource::ProviderModels,
        "projects" => Resource::Projects,
        "project-models" => Resource::ProjectModels,
        "routes" => Resource::Routes,
        _ => return error(StatusCode::NOT_FOUND, "not_found"),
    };
    let Ok(Query(parameters)) = query else {
        return error(StatusCode::BAD_REQUEST, "invalid_query");
    };
    if !parameters.validate(resource, is_detail) {
        return error(StatusCode::BAD_REQUEST, "invalid_query");
    }
    let page = parameters.page.unwrap_or(1);
    let size = parameters.page_size.unwrap_or(25);
    match read::fetch(pool, resource, &parameters.filters(is_detail, page, size)).await {
        Ok((revision, mut items)) if is_detail => items.pop().map_or_else(
            || error(StatusCode::NOT_FOUND, "not_found"),
            |item| Json(json!({ "revision": revision, "item": item })).into_response(),
        ),
        Ok((revision, mut items)) => {
            let has_next = i64::try_from(items.len()).is_ok_and(|n| n > size);
            if has_next {
                items.pop();
            }
            Json(json!({ "revision": revision, "items": items, "page": page, "pageSize": size, "hasNext": has_next })).into_response()
        }
        Err(err) => database_error(&err),
    }
}

/// Tests whether a required ID was provided.
fn nonempty(value: Option<&str>) -> bool {
    value.is_some_and(|s| !s.is_empty())
}

/// Keeps internal errors out of HTTP responses.
fn database_error(err: &sqlx::Error) -> Response {
    tracing::warn!(error = %err, "catalog read failed");
    match err {
        sqlx::Error::Io(_)
        | sqlx::Error::Tls(_)
        | sqlx::Error::PoolClosed
        | sqlx::Error::PoolTimedOut => unavailable(),
        sqlx::Error::Database(err)
            if err.code().is_some_and(|code| {
                code.starts_with("08")
                    || matches!(code.as_ref(), "57P01" | "57P02" | "57P03" | "53300")
            }) =>
        {
            unavailable()
        }
        _ => error(StatusCode::INTERNAL_SERVER_ERROR, "catalog_query_failed"),
    }
}

/// Returns the catalog-specific unavailable response.
fn unavailable() -> Response {
    error(StatusCode::SERVICE_UNAVAILABLE, "catalog_unavailable")
}

/// Standard catalog error body.
fn error(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({ "error": code }))).into_response()
}
