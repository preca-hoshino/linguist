//! OIDC login, callback, session status, logout, and admin session middleware.

use axum::extract::{Extension, Query, Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use tracing::warn;

use crate::auth::jwt::pkce_code_challenge;
use crate::auth::session::{
    AdminSession, build_session_cookie, clear_session_cookie, consume_login_transaction,
    create_login_transaction, extract_session_cookie, load_valid_admin_session, revoke_session,
    sanitize_return_to, upsert_identity_and_create_session,
};
use crate::catalog::secrets::tokens_equal;
use crate::state::AppState;

/// Registers `/auth/login`, `/auth/callback`, and `/auth/logout`.
pub(super) fn public_router() -> Router<AppState> {
    Router::new()
        .route("/auth/login", get(login_handler))
        .route("/auth/callback", get(callback_handler))
        .route("/auth/logout", post(logout_handler))
}

/// Registers `/api/auth/me` (protected by `require_admin_session`).
pub(super) fn protected_router() -> Router<AppState> {
    Router::new().route("/api/auth/me", get(me_handler))
}

/// Query parameters for `GET /auth/login`.
#[derive(Debug, Deserialize)]
struct LoginQuery {
    /// Optional in-site path to return to after login.
    #[serde(default)]
    return_to: Option<String>,
}

/// Query parameters for `GET /auth/callback`.
#[derive(Debug, Deserialize)]
struct CallbackQuery {
    /// Authorization code returned by the `IdP`.
    #[serde(default)]
    code: Option<String>,
    /// Opaque CSRF/transaction state returned by the `IdP`.
    #[serde(default)]
    state: Option<String>,
    /// Optional `OAuth2` error code returned by the `IdP`.
    #[serde(default)]
    error: Option<String>,
}

/// Middleware enforcing a valid, non-expired admin session matching the configured
/// `issuer` and `LINGUIST_OIDC_ADMIN_SUB` on every management request.
pub(super) async fn require_admin_session(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Response {
    let (Some(oidc), Some(pool)) = (state.oidc.as_ref(), state.db_pool.as_ref()) else {
        return json_error(StatusCode::SERVICE_UNAVAILABLE, "auth_unavailable");
    };

    let Some(raw_token) = extract_session_cookie(request.headers()) else {
        return json_error(StatusCode::UNAUTHORIZED, "unauthorized");
    };

    let session = match load_valid_admin_session(
        pool,
        state.redis.as_ref(),
        &raw_token,
        &oidc.config().issuer,
        &oidc.config().admin_sub,
    )
    .await
    {
        Ok(Some(session)) => session,
        Ok(None) => {
            let mut resp = json_error(StatusCode::UNAUTHORIZED, "unauthorized");
            if let Ok(cookie) =
                HeaderValue::from_str(&clear_session_cookie(oidc.config().secure_cookies))
            {
                resp.headers_mut().insert(header::SET_COOKIE, cookie);
            }
            return resp;
        }
        Err(err) => {
            warn!(error = %err, "failed to verify admin session in PostgreSQL");
            return json_error(StatusCode::SERVICE_UNAVAILABLE, "auth_unavailable");
        }
    };

    request.extensions_mut().insert(session);
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// Starts the OIDC Authorization Code + PKCE flow and redirects to the `IdP`.
async fn login_handler(State(state): State<AppState>, Query(query): Query<LoginQuery>) -> Response {
    let (Some(oidc), Some(pool)) = (state.oidc.as_ref(), state.db_pool.as_ref()) else {
        return Redirect::to("/?auth_error=auth_unavailable").into_response();
    };

    let return_to = sanitize_return_to(query.return_to.as_deref());
    let (tx_state, nonce, pkce_verifier) =
        match create_login_transaction(pool, state.redis.as_ref(), &return_to).await {
            Ok(vals) => vals,
            Err(err) => {
                warn!(error = %err, "failed to create OIDC login transaction");
                return Redirect::to("/?auth_error=auth_unavailable").into_response();
            }
        };

    let challenge = pkce_code_challenge(&pkce_verifier);
    match oidc
        .build_authorization_url(&tx_state, &nonce, &challenge)
        .await
    {
        Ok(auth_url) => {
            let mut resp = Redirect::to(&auth_url).into_response();
            resp.headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            resp
        }
        Err(err) => {
            warn!(error = %err, "failed to build OIDC authorization URL");
            Redirect::to("/?auth_error=oidc_unavailable").into_response()
        }
    }
}

/// Handles the OIDC callback, verifies the ID token and admin `sub`, and creates a session.
async fn callback_handler(
    State(state): State<AppState>,
    Query(query): Query<CallbackQuery>,
) -> Response {
    let (Some(oidc), Some(pool)) = (state.oidc.as_ref(), state.db_pool.as_ref()) else {
        return Redirect::to("/?auth_error=auth_unavailable").into_response();
    };

    if query.error.is_some() {
        return Redirect::to("/?auth_error=oidc_denied").into_response();
    }

    let (Some(code), Some(tx_state)) = (
        query.code.as_deref().filter(|s| !s.is_empty()),
        query.state.as_deref().filter(|s| !s.is_empty()),
    ) else {
        return Redirect::to("/?auth_error=invalid_request").into_response();
    };

    let tx = match consume_login_transaction(pool, state.redis.as_ref(), tx_state).await {
        Ok(Some(tx)) => tx,
        Ok(None) => return Redirect::to("/?auth_error=invalid_state").into_response(),
        Err(err) => {
            warn!(error = %err, "failed to consume OIDC login transaction");
            return Redirect::to("/?auth_error=auth_unavailable").into_response();
        }
    };

    let claims = match oidc
        .exchange_and_verify_code(code, &tx.pkce_verifier, &tx.nonce)
        .await
    {
        Ok(claims) => claims,
        Err(err) => {
            warn!(error = %err, "OIDC code exchange or ID token verification failed");
            return Redirect::to("/?auth_error=oidc_error").into_response();
        }
    };

    if claims.iss != oidc.config().issuer || claims.sub != oidc.config().admin_sub {
        warn!(
            subject = %claims.sub,
            "OIDC login rejected: authenticated identity is not the configured admin"
        );
        return Redirect::to("/?auth_error=forbidden").into_response();
    }

    let created = match upsert_identity_and_create_session(
        pool,
        state.redis.as_ref(),
        &claims,
        &oidc.config().issuer,
    )
    .await
    {
        Ok(created) => created,
        Err(err) => {
            warn!(error = %err, "failed to create admin session");
            return Redirect::to("/?auth_error=auth_unavailable").into_response();
        }
    };

    let mut resp = Redirect::to(&tx.return_to).into_response();
    resp.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if let Ok(cookie) = HeaderValue::from_str(&build_session_cookie(
        &created.raw_token,
        oidc.config().secure_cookies,
    )) {
        resp.headers_mut().insert(header::SET_COOKIE, cookie);
    }
    resp
}

/// Returns the authenticated admin session metadata and CSRF token.
async fn me_handler(Extension(session): Extension<AdminSession>) -> Response {
    (
        StatusCode::OK,
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({
            "authenticated": true,
            "subject": session.subject,
            "email": session.email,
            "displayName": session.display_name,
            "csrfToken": session.csrf_token,
            "expiresAt": session.expires_at,
        })),
    )
        .into_response()
}

/// Revokes the active admin session and clears the session cookie after CSRF verification.
async fn logout_handler(State(state): State<AppState>, request: Request) -> Response {
    let (Some(oidc), Some(pool)) = (state.oidc.as_ref(), state.db_pool.as_ref()) else {
        return json_error(StatusCode::SERVICE_UNAVAILABLE, "auth_unavailable");
    };

    let raw_token = extract_session_cookie(request.headers());
    if let Some(raw_token) = &raw_token {
        match load_valid_admin_session(
            pool,
            state.redis.as_ref(),
            raw_token,
            &oidc.config().issuer,
            &oidc.config().admin_sub,
        )
        .await
        {
            Ok(Some(session)) => {
                let provided_csrf = request
                    .headers()
                    .get("x-csrf-token")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("");
                if !tokens_equal(session.csrf_token.as_bytes(), provided_csrf.as_bytes()) {
                    return json_error(StatusCode::FORBIDDEN, "csrf_mismatch");
                }
                if let Err(err) = revoke_session(pool, state.redis.as_ref(), raw_token).await {
                    warn!(error = %err, "failed to revoke admin session on logout");
                }
            }
            Ok(None) => {}
            Err(err) => {
                warn!(error = %err, "failed to look up session on logout");
                return json_error(StatusCode::SERVICE_UNAVAILABLE, "auth_unavailable");
            }
        }
    }

    let mut resp = (
        StatusCode::OK,
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({ "ok": true })),
    )
        .into_response();
    if let Ok(cookie) = HeaderValue::from_str(&clear_session_cookie(oidc.config().secure_cookies)) {
        resp.headers_mut().insert(header::SET_COOKIE, cookie);
    }
    resp
}

/// Verifies `X-CSRF-Token` against the active [`AdminSession`] on state-changing admin routes.
pub(super) fn verify_csrf(session: &AdminSession, headers: &axum::http::HeaderMap) -> bool {
    let provided = headers
        .get("x-csrf-token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    tokens_equal(session.csrf_token.as_bytes(), provided.as_bytes())
}

/// Returns a JSON error response with `Cache-Control: no-store`.
fn json_error(status: StatusCode, code: &'static str) -> Response {
    (
        status,
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({ "error": code })),
    )
        .into_response()
}
