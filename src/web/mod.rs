//! Embedded static React frontend (`rust-embed`), `LobeHub` SVG serving, SPA fallback,
//! and combined Axum HTTP router construction.

pub mod stats_api;

use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde_json::json;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

use crate::icons;
use crate::proxy;
use crate::state::AppState;

/// Inner module containing the `RustEmbed` derive so generated items do not violate
/// strict `missing_docs` or Clippy pedantic lints.
#[allow(
    missing_docs,
    clippy::all,
    clippy::pedantic,
    clippy::missing_docs_in_private_items
)]
mod embedded_assets {
    use rust_embed::RustEmbed;

    /// Embedded `frontend/dist` bundle.
    #[derive(RustEmbed)]
    #[folder = "frontend/dist"]
    pub(super) struct FrontendDist;
}

/// Builds the full Linguist HTTP router combining proxy endpoints, read-only stats API,
/// `/icons/*` SVG assets, and embedded SPA static files.
pub fn build_router(state: AppState) -> Router {
    Router::new()
        .merge(proxy::router())
        .merge(stats_api::router())
        .route("/icons/{icon_name}", get(serve_icon_handler))
        .fallback(spa_fallback_handler)
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

/// Serves `LobeHub` or custom override SVG icons from disk (with built-in fallback).
async fn serve_icon_handler(
    State(state): State<AppState>,
    Path(icon_name): Path<String>,
) -> Response {
    let Some(svg) = icons::resolve_icon_svg(&state.config.icons, &icon_name) else {
        return (StatusCode::NOT_FOUND, "Icon not found").into_response();
    };

    let mut headers = HeaderMap::new();
    headers.insert(
        HeaderName::from_static("content-type"),
        HeaderValue::from_static("image/svg+xml; charset=utf-8"),
    );
    headers.insert(
        HeaderName::from_static("cache-control"),
        HeaderValue::from_static("public, max-age=86400"),
    );
    (StatusCode::OK, headers, svg).into_response()
}

/// Serves embedded `frontend/dist` files and falls back to `index.html` for SPA routes,
/// returning HTTP 404 for unmatched `/api`, `/model`, or `/icons` paths. The removed legacy
/// endpoints (`/v1`, `/g`, `/p`) return a JSON 404 pointing at `/model/{project_id}/v1`.
async fn spa_fallback_handler(uri: Uri) -> Response {
    let raw_path = uri.path().trim_start_matches('/');

    if raw_path.starts_with("v1/") || raw_path.starts_with("g/") || raw_path.starts_with("p/") {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({
                "error": {
                    "code": 404,
                    "message": "Endpoint removed. Use /model/{project_id}/v1/chat/completions \
                                or /model/{project_id}/v1/models",
                    "type": "not_found_error"
                }
            })),
        )
            .into_response();
    }

    if raw_path.starts_with("api/")
        || raw_path.starts_with("model/")
        || raw_path.starts_with("icons/")
    {
        return (StatusCode::NOT_FOUND, "Not Found").into_response();
    }

    let lookup = if raw_path.is_empty() {
        "index.html"
    } else {
        raw_path
    };

    if let Some(asset) = embedded_assets::FrontendDist::get(lookup) {
        return asset_response(lookup, asset.data.into_owned());
    }

    if let Some(index) = embedded_assets::FrontendDist::get("index.html") {
        return asset_response("index.html", index.data.into_owned());
    }

    (StatusCode::NOT_FOUND, "Frontend bundle missing").into_response()
}

/// Converts embedded file bytes into an HTTP response with inferred MIME `Content-Type`.
fn asset_response(path: &str, bytes: Vec<u8>) -> Response {
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let mut headers = HeaderMap::new();
    if let Ok(val) = HeaderValue::from_str(mime.as_ref()) {
        headers.insert(HeaderName::from_static("content-type"), val);
    }
    (StatusCode::OK, headers, bytes).into_response()
}
