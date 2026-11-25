//! Authenticated read-write catalog administration, script validation, and dry-run endpoints.

use axum::extract::rejection::QueryRejection;
use axum::extract::{Extension, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use crate::auth::session::AdminSession;
use crate::catalog::postgres::PgCatalogProvider;
use crate::catalog::postgres::catalog_status;
use crate::catalog::postgres::write::{
    ProjectModelWriteInput, ProjectWriteInput, ProviderModelWriteInput, ProviderWriteInput,
    RouteWriteInput,
};
use crate::catalog::read::{self, Filters, Resource};
use crate::catalog::secrets::CatalogSecrets;
use crate::catalog::sync;
use crate::models::ScriptItem;
use crate::script_engine::pipeline::{StageOutcome, prepare_attempt_context, run_routing_stages};
use crate::state::AppState;
use crate::web::auth_api;

/// Registers catalog read-write endpoints (protected by admin session middleware).
pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/catalog/status", get(status))
        .route("/api/v1/catalog/scripts/validate", post(validate_scripts))
        .route("/api/v1/catalog/dry-run", post(dry_run))
        .route(
            "/api/v1/catalog/{resource}",
            get(list).post(create).put(update).delete(remove),
        )
        .route("/api/v1/catalog/{resource}/detail", get(detail))
        .route("/api/v1/catalog/{resource}/reorder", post(reorder))
}

/// Query parameters for lists, details, and deletes.
#[derive(Debug, Deserialize)]
struct Parameters {
    /// Exact entry ID, required for detail/delete queries.
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
    /// Optional expected revision for optimistic concurrency on delete.
    expected_revision: Option<i64>,
}

impl Parameters {
    /// Rejects malformed ranges, missing detail scope, and NUL strings before touching PostgreSQL.
    fn validate(&self, resource: Resource, is_detail: bool) -> bool {
        let text = [&self.id, &self.q, &self.provider_id, &self.project_id];
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
            limit: if is_detail { 1 } else { size + 1 },
            offset: if is_detail { 0 } else { (page - 1) * size },
        }
    }
}

/// Request payload for `POST /api/v1/catalog/{resource}/reorder`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReorderInput {
    /// Optional parent ID (`provider_id` or `project_id`) for scoped model tables.
    parent_id: Option<String>,
    /// Complete ordered list of IDs.
    ordered_ids: Vec<String>,
    /// Optional optimistic concurrency revision.
    expected_revision: Option<i64>,
}

/// Request payload for `POST /api/v1/catalog/scripts/validate`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ValidateScriptsInput {
    /// Script chain to compile and inspect.
    scripts: Vec<ScriptItem>,
}

/// Request payload for `POST /api/v1/catalog/dry-run`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DryRunInput {
    /// Project ID to simulate.
    project_id: String,
    /// Requested model ID.
    model: String,
    /// Optional stream flag.
    #[serde(default)]
    stream: bool,
    /// Optional custom JSON body fields.
    #[serde(default)]
    body: Option<Map<String, Value>>,
}

/// Parses `{resource}` path segment into `Resource`.
fn parse_resource(resource: &str) -> Option<Resource> {
    match resource {
        "providers" => Some(Resource::Providers),
        "provider-models" => Some(Resource::ProviderModels),
        "projects" => Some(Resource::Projects),
        "project-models" => Some(Resource::ProjectModels),
        "routes" => Some(Resource::Routes),
        _ => None,
    }
}

/// Constructs a `PgCatalogProvider` from `AppState`.
#[allow(clippy::result_large_err)]
fn build_pg_provider(state: &AppState) -> Result<PgCatalogProvider, Response> {
    let Some(pool) = state.db_pool.as_ref() else {
        return Err(unavailable());
    };
    let secrets = CatalogSecrets::from_env().map_err(|err| {
        error_with_msg(
            StatusCode::INTERNAL_SERVER_ERROR,
            "secrets_error",
            &err.to_string(),
        )
    })?;
    Ok(PgCatalogProvider::new(
        pool.clone(),
        secrets,
        state.engine.clone(),
    ))
}

/// Returns committed revision and this instance's loaded revision.
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

/// Returns the selected resource's full editable fields.
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

/// Creates a new catalog resource entry.
async fn create(
    State(state): State<AppState>,
    Extension(session): Extension<AdminSession>,
    headers: HeaderMap,
    Path(resource): Path<String>,
    Json(payload): Json<Value>,
) -> Response {
    if !auth_api::verify_csrf(&session, &headers) {
        return error(StatusCode::FORBIDDEN, "csrf_mismatch");
    }
    let Some(resource) = parse_resource(&resource) else {
        return error(StatusCode::NOT_FOUND, "not_found");
    };
    let store = match build_pg_provider(&state) {
        Ok(s) => s,
        Err(resp) => return resp,
    };

    let res = match resource {
        Resource::Providers => match parse_json::<ProviderWriteInput>(payload) {
            Ok(input) => store.create_provider(input).await,
            Err(resp) => return resp,
        },
        Resource::ProviderModels => match parse_json::<ProviderModelWriteInput>(payload) {
            Ok(input) => store.create_provider_model(input).await,
            Err(resp) => return resp,
        },
        Resource::Projects => match parse_json::<ProjectWriteInput>(payload) {
            Ok(input) => store.create_project(input).await,
            Err(resp) => return resp,
        },
        Resource::ProjectModels => match parse_json::<ProjectModelWriteInput>(payload) {
            Ok(input) => store.create_project_model(input).await,
            Err(resp) => return resp,
        },
        Resource::Routes => match parse_json::<RouteWriteInput>(payload) {
            Ok(input) => store.create_route(input).await,
            Err(resp) => return resp,
        },
    };

    let rev = match res {
        Ok(rev) => rev,
        Err(err) => return write_error(&err),
    };

    refresh_runtime_after_write(&state, &store, rev).await
}

/// Updates an existing catalog resource entry.
async fn update(
    State(state): State<AppState>,
    Extension(session): Extension<AdminSession>,
    headers: HeaderMap,
    Path(resource): Path<String>,
    Json(payload): Json<Value>,
) -> Response {
    if !auth_api::verify_csrf(&session, &headers) {
        return error(StatusCode::FORBIDDEN, "csrf_mismatch");
    }
    let Some(resource) = parse_resource(&resource) else {
        return error(StatusCode::NOT_FOUND, "not_found");
    };
    let store = match build_pg_provider(&state) {
        Ok(s) => s,
        Err(resp) => return resp,
    };

    let res = match resource {
        Resource::Providers => match parse_json::<ProviderWriteInput>(payload) {
            Ok(input) => store.update_provider(input).await,
            Err(resp) => return resp,
        },
        Resource::ProviderModels => match parse_json::<ProviderModelWriteInput>(payload) {
            Ok(input) => store.update_provider_model(input).await,
            Err(resp) => return resp,
        },
        Resource::Projects => match parse_json::<ProjectWriteInput>(payload) {
            Ok(input) => store.update_project(input).await,
            Err(resp) => return resp,
        },
        Resource::ProjectModels => match parse_json::<ProjectModelWriteInput>(payload) {
            Ok(input) => store.update_project_model(input).await,
            Err(resp) => return resp,
        },
        Resource::Routes => match parse_json::<RouteWriteInput>(payload) {
            Ok(input) => store.update_route(input).await,
            Err(resp) => return resp,
        },
    };

    let rev = match res {
        Ok(rev) => rev,
        Err(err) => return write_error(&err),
    };

    refresh_runtime_after_write(&state, &store, rev).await
}

/// Deletes a catalog resource entry by query parameters (`id`, optional parent scope).
async fn remove(
    State(state): State<AppState>,
    Extension(session): Extension<AdminSession>,
    headers: HeaderMap,
    Path(resource): Path<String>,
    query: Result<Query<Parameters>, QueryRejection>,
) -> Response {
    if !auth_api::verify_csrf(&session, &headers) {
        return error(StatusCode::FORBIDDEN, "csrf_mismatch");
    }
    let Some(resource) = parse_resource(&resource) else {
        return error(StatusCode::NOT_FOUND, "not_found");
    };
    let Ok(Query(parameters)) = query else {
        return error(StatusCode::BAD_REQUEST, "invalid_query");
    };
    if !parameters.validate(resource, true) {
        return error(StatusCode::BAD_REQUEST, "invalid_query");
    }
    let Some(id) = parameters.id.as_deref() else {
        return error(StatusCode::BAD_REQUEST, "invalid_query");
    };
    let parent_id = match resource {
        Resource::ProviderModels => parameters.provider_id.as_deref(),
        Resource::ProjectModels => parameters.project_id.as_deref(),
        _ => None,
    };
    let store = match build_pg_provider(&state) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let rev = match store
        .delete_resource(resource, id, parent_id, parameters.expected_revision)
        .await
    {
        Ok(rev) => rev,
        Err(err) => return write_error(&err),
    };

    refresh_runtime_after_write(&state, &store, rev).await
}

/// Reorders entries in a catalog resource table.
async fn reorder(
    State(state): State<AppState>,
    Extension(session): Extension<AdminSession>,
    headers: HeaderMap,
    Path(resource): Path<String>,
    Json(input): Json<ReorderInput>,
) -> Response {
    if !auth_api::verify_csrf(&session, &headers) {
        return error(StatusCode::FORBIDDEN, "csrf_mismatch");
    }
    let Some(resource) = parse_resource(&resource) else {
        return error(StatusCode::NOT_FOUND, "not_found");
    };
    let store = match build_pg_provider(&state) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let rev = match store
        .reorder_resource(
            resource,
            input.parent_id.as_deref(),
            &input.ordered_ids,
            input.expected_revision,
        )
        .await
    {
        Ok(rev) => rev,
        Err(err) => return write_error(&err),
    };

    refresh_runtime_after_write(&state, &store, rev).await
}

/// Compiles and validates a candidate `scripts[]` chain without saving it.
async fn validate_scripts(
    State(state): State<AppState>,
    Extension(session): Extension<AdminSession>,
    headers: HeaderMap,
    Json(input): Json<ValidateScriptsInput>,
) -> Response {
    if !auth_api::verify_csrf(&session, &headers) {
        return error(StatusCode::FORBIDDEN, "csrf_mismatch");
    }
    match state.engine.compile_chain(&input.scripts) {
        Ok(chain) => Json(json!({
            "ok": true,
            "tags": chain.tags,
            "meta": chain.meta,
            "hooks": chain.hooks,
        }))
        .into_response(),
        Err(err) => (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "ok": false,
                "error": "script_compile_failed",
                "message": err.to_string(),
            })),
        )
            .into_response(),
    }
}

/// Simulates Stages ①..⑤ for a project/model request without sending upstream HTTP traffic.
async fn dry_run(
    State(state): State<AppState>,
    Extension(session): Extension<AdminSession>,
    headers: HeaderMap,
    Json(input): Json<DryRunInput>,
) -> Response {
    if !auth_api::verify_csrf(&session, &headers) {
        return error(StatusCode::FORBIDDEN, "csrf_mismatch");
    }
    let catalog = state.catalog.load_full();
    let mut body = input.body.unwrap_or_default();
    body.entry("model".to_string())
        .or_insert_with(|| Value::String(input.model.clone()));
    body.entry("stream".to_string())
        .or_insert_with(|| Value::Bool(input.stream));
    body.entry("messages".to_string())
        .or_insert_with(|| json!([{ "role": "user", "content": "dry-run" }]));

    let outcome = match run_routing_stages(
        &catalog,
        &state.metrics,
        &state.engine,
        Uuid::new_v4(),
        &input.project_id,
        &input.model,
        body,
    )
    .await
    {
        Ok(o) => o,
        Err(err) => {
            return error_with_msg(StatusCode::BAD_REQUEST, "dry_run_failed", &err.to_string());
        }
    };

    match outcome {
        StageOutcome::Rejected(rej) => Json(json!({
            "status": "rejected",
            "statusCode": rej.status_code,
            "message": rej.message,
        }))
        .into_response(),
        StageOutcome::Ready(plan) => {
            let mut candidates = Vec::new();
            for (idx, ep) in plan.endpoints.iter().enumerate() {
                let Some((prov, pm)) = catalog.find_model(&ep.provider_id, &ep.model_id) else {
                    candidates.push(json!({
                        "providerId": ep.provider_id,
                        "modelId": ep.model_id,
                        "status": "missing_in_catalog",
                    }));
                    continue;
                };
                let attempt = u16::try_from(idx + 1).unwrap_or(u16::MAX);
                match prepare_attempt_context(&plan.snapshot_ctx, attempt, prov, pm, &state.engine)
                    .await
                {
                    Ok(StageOutcome::Ready(ctx)) => candidates.push(json!({
                        "providerId": ep.provider_id,
                        "modelId": ep.model_id,
                        "status": "ready",
                        "url": ctx.request.url,
                        "body": ctx.request.body,
                        "state": ctx.state,
                    })),
                    Ok(StageOutcome::Rejected(rej)) => candidates.push(json!({
                        "providerId": ep.provider_id,
                        "modelId": ep.model_id,
                        "status": "rejected",
                        "statusCode": rej.status_code,
                        "message": rej.message,
                    })),
                    Err(err) => candidates.push(json!({
                        "providerId": ep.provider_id,
                        "modelId": ep.model_id,
                        "status": "error",
                        "error": err.to_string(),
                    })),
                }
            }
            Json(json!({
                "status": "ready",
                "routeRuleId": plan.snapshot_ctx.route.rule_id,
                "candidates": candidates,
            }))
            .into_response()
        }
    }
}

/// Reloads the runtime catalog and FX rates after a successful DB write.
async fn refresh_runtime_after_write(
    state: &AppState,
    store: &PgCatalogProvider,
    committed_rev: i64,
) -> Response {
    let loaded = match sync::reload_now(store, &state.catalog).await {
        Ok(rev) => rev,
        Err(err) => {
            tracing::warn!(error = %err, "catalog write succeeded but runtime reload failed");
            committed_rev
        }
    };
    crate::billing::fx::refresh_after_catalog_change(state);
    Json(json!({ "ok": true, "revision": loaded })).into_response()
}

/// Deserializes a JSON value into a typed write payload or returns 400.
#[allow(clippy::result_large_err)]
fn parse_json<T: serde::de::DeserializeOwned>(payload: Value) -> Result<T, Response> {
    serde_json::from_value(payload)
        .map_err(|err| error_with_msg(StatusCode::BAD_REQUEST, "invalid_payload", &err.to_string()))
}

/// Validates query and selects the appropriate list or detail envelope.
async fn fetch(
    pool: &PgPool,
    resource: &str,
    query: Result<Query<Parameters>, QueryRejection>,
    is_detail: bool,
) -> Response {
    let Some(resource) = parse_resource(resource) else {
        return error(StatusCode::NOT_FOUND, "not_found");
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

/// Maps write/validation errors to HTTP status codes.
fn write_error(err: &anyhow::Error) -> Response {
    let msg = err.to_string();
    if msg.contains("revision_conflict") {
        error_with_msg(StatusCode::CONFLICT, "revision_conflict", &msg)
    } else if msg.contains("not_found") {
        error_with_msg(StatusCode::NOT_FOUND, "not_found", &msg)
    } else if msg.contains("has_children") {
        error_with_msg(StatusCode::CONFLICT, "has_children", &msg)
    } else {
        error_with_msg(StatusCode::BAD_REQUEST, "catalog_write_failed", &msg)
    }
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

/// Catalog error body with human-readable details.
fn error_with_msg(status: StatusCode, code: &str, message: &str) -> Response {
    (status, Json(json!({ "error": code, "message": message }))).into_response()
}
