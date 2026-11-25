//! PostgreSQL-backed OIDC login transactions, admin sessions, and cookie helpers.

use anyhow::{Context, Result};
use axum::http::HeaderMap;
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use tracing::warn;
use uuid::Uuid;

use crate::auth::jwt::{IdTokenClaims, random_token_b64, sha256};
use crate::redis_store::RedisStore;

/// HTTP cookie name storing the opaque admin session token.
pub const SESSION_COOKIE_NAME: &str = "linguist_session";

/// Fixed absolute session lifetime (8 hours); never extended by dashboard polling.
pub const SESSION_TTL_SECS: i64 = 8 * 60 * 60;

/// Lifetime of an in-flight OIDC login transaction (10 minutes).
const TRANSACTION_TTL_SECS: i64 = 600;

/// Single-use OIDC login transaction loaded upon callback.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginTransaction {
    /// Nonce expected in the returned ID token.
    pub nonce: String,
    /// PKCE code verifier sent during token exchange.
    pub pkce_verifier: String,
    /// Sanitized in-site redirect path after login.
    pub return_to: String,
}

/// Newly created admin session returned to the callback handler.
#[derive(Debug)]
pub struct CreatedSession {
    /// Opaque session secret placed in the `HttpOnly` cookie.
    pub raw_token: String,
    /// Per-session CSRF token exposed via `/api/auth/me`.
    pub csrf_token: String,
    /// Absolute expiration timestamp.
    pub expires_at: DateTime<Utc>,
}

/// Verified admin session for the currently configured `issuer` and `admin_sub`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdminSession {
    /// Session identifier.
    pub session_id: Uuid,
    /// OIDC issuer bound to this session.
    pub issuer: String,
    /// OIDC subject bound to this session.
    pub subject: String,
    /// Optional email for UI display.
    pub email: Option<String>,
    /// Optional display name for UI display.
    pub display_name: Option<String>,
    /// Per-session CSRF token.
    pub csrf_token: String,
    /// Absolute expiration timestamp.
    pub expires_at: DateTime<Utc>,
}

/// Validates and normalizes `return_to` so only relative in-site paths are accepted.
#[must_use]
pub fn sanitize_return_to(raw: Option<&str>) -> String {
    let Some(candidate) = raw.map(str::trim) else {
        return "/".to_string();
    };
    if candidate.is_empty()
        || !candidate.starts_with('/')
        || candidate.starts_with("//")
        || candidate.starts_with("/\\")
        || candidate.contains(['\r', '\n', '\0', '\\'])
    {
        return "/".to_string();
    }
    candidate.to_string()
}

/// Extracts the `linguist_session` cookie value from HTTP request headers.
#[must_use]
pub fn extract_session_cookie(headers: &HeaderMap) -> Option<String> {
    let cookie_header = headers.get(axum::http::header::COOKIE)?.to_str().ok()?;
    for part in cookie_header.split(';') {
        let trimmed = part.trim();
        if let Some((name, value)) = trimmed.split_once('=')
            && name.trim() == SESSION_COOKIE_NAME
        {
            let val = value.trim();
            if !val.is_empty() {
                return Some(val.to_string());
            }
        }
    }
    None
}

/// Formats the `Set-Cookie` header value for an active admin session.
#[must_use]
pub fn build_session_cookie(raw_token: &str, secure: bool) -> String {
    let secure_attr = if secure { "; Secure" } else { "" };
    format!(
        "{SESSION_COOKIE_NAME}={raw_token}; HttpOnly; Path=/; SameSite=Lax; Max-Age={SESSION_TTL_SECS}{secure_attr}"
    )
}

/// Formats the `Set-Cookie` header value that expires the admin session cookie.
#[must_use]
pub fn clear_session_cookie(secure: bool) -> String {
    let secure_attr = if secure { "; Secure" } else { "" };
    format!("{SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0{secure_attr}")
}

/// Encodes a byte slice as lowercase hexadecimal for Redis key namespacing.
fn hex_encode(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(out, "{b:02x}");
    }
    out
}

/// Creates a new single-use OIDC login transaction (Redis-first when enabled, otherwise PostgreSQL).
///
/// Returns `(state, nonce, pkce_verifier)`.
///
/// # Errors
/// Returns an error if CSPRNG or persistence fails.
pub async fn create_login_transaction(
    pool: &PgPool,
    redis: Option<&RedisStore>,
    return_to: &str,
) -> Result<(String, String, String)> {
    let state = random_token_b64(32)?;
    let nonce = random_token_b64(32)?;
    let pkce_verifier = random_token_b64(48)?;
    let state_hash = sha256(state.as_bytes());
    let safe_return = sanitize_return_to(Some(return_to));

    if let Some(redis) = redis {
        let tx = LoginTransaction {
            nonce: nonce.clone(),
            pkce_verifier: pkce_verifier.clone(),
            return_to: safe_return.clone(),
        };
        let key = redis.key(&format!("sys:oidc_tx:{}", hex_encode(&state_hash)));
        match redis
            .set_json_ex(
                &key,
                &tx,
                u64::try_from(TRANSACTION_TTL_SECS).unwrap_or(600),
            )
            .await
        {
            Ok(()) => return Ok((state, nonce, pkce_verifier)),
            Err(err) if redis.fail_open() => {
                warn!(error = %err, "failed to store OIDC transaction in Redis; falling back to PostgreSQL");
            }
            Err(err) => return Err(err),
        }
    }

    let expires_at = Utc::now() + Duration::seconds(TRANSACTION_TTL_SECS);
    sqlx::query(
        "INSERT INTO oidc_login_transactions (id, state_hash, nonce, pkce_verifier, return_to, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(Uuid::new_v4())
    .bind(state_hash.as_slice())
    .bind(&nonce)
    .bind(&pkce_verifier)
    .bind(&safe_return)
    .bind(expires_at)
    .execute(pool)
    .await
    .context("failed to persist OIDC login transaction")?;

    Ok((state, nonce, pkce_verifier))
}

/// Atomically consumes a valid, unexpired OIDC login transaction matching `state`.
///
/// # Errors
/// Returns an error if the store query fails.
pub async fn consume_login_transaction(
    pool: &PgPool,
    redis: Option<&RedisStore>,
    state: &str,
) -> Result<Option<LoginTransaction>> {
    let state_hash = sha256(state.as_bytes());

    if let Some(redis) = redis {
        let key = redis.key(&format!("sys:oidc_tx:{}", hex_encode(&state_hash)));
        match redis.get_del_json::<LoginTransaction>(&key).await {
            Ok(Some(tx)) => return Ok(Some(tx)),
            Ok(None) => {}
            Err(err) if redis.fail_open() => {
                warn!(error = %err, "failed to consume OIDC transaction from Redis; checking PostgreSQL");
            }
            Err(err) => return Err(err),
        }
    }

    let row = sqlx::query(
        "UPDATE oidc_login_transactions
         SET consumed_at = NOW()
         WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at > NOW()
         RETURNING nonce, pkce_verifier, return_to",
    )
    .bind(state_hash.as_slice())
    .fetch_optional(pool)
    .await
    .context("failed to consume OIDC login transaction")?;

    Ok(row.map(|r| LoginTransaction {
        nonce: r.get("nonce"),
        pkce_verifier: r.get("pkce_verifier"),
        return_to: r.get("return_to"),
    }))
}

/// Records the OIDC identity for audit/association and creates a fixed 8-hour admin session.
///
/// # Errors
/// Returns an error if database persistence fails.
pub async fn upsert_identity_and_create_session(
    pool: &PgPool,
    redis: Option<&RedisStore>,
    claims: &IdTokenClaims,
    issuer: &str,
) -> Result<CreatedSession> {
    let display_name = claims
        .name
        .as_deref()
        .or(claims.preferred_username.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let identity_id: Uuid = sqlx::query_scalar(
        "INSERT INTO oidc_identities (id, issuer, subject, email, display_name, first_seen_at, last_login_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
         ON CONFLICT (issuer, subject) DO UPDATE
         SET email = COALESCE(EXCLUDED.email, oidc_identities.email),
             display_name = COALESCE(EXCLUDED.display_name, oidc_identities.display_name),
             last_login_at = NOW()
         RETURNING id",
    )
    .bind(Uuid::new_v4())
    .bind(issuer)
    .bind(&claims.sub)
    .bind(claims.email.as_deref())
    .bind(display_name)
    .fetch_one(pool)
    .await
    .context("failed to upsert OIDC identity record")?;

    let raw_token = random_token_b64(32)?;
    let csrf_token = random_token_b64(24)?;
    let token_hash = sha256(raw_token.as_bytes());
    let expires_at = Utc::now() + Duration::seconds(SESSION_TTL_SECS);
    let session_id = Uuid::new_v4();

    sqlx::query(
        "INSERT INTO admin_sessions (id, token_hash, identity_id, issuer, subject, csrf_token, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(session_id)
    .bind(token_hash.as_slice())
    .bind(identity_id)
    .bind(issuer)
    .bind(&claims.sub)
    .bind(&csrf_token)
    .bind(expires_at)
    .execute(pool)
    .await
    .context("failed to create admin session")?;

    if let Some(redis) = redis {
        let cached = AdminSession {
            session_id,
            issuer: issuer.to_string(),
            subject: claims.sub.clone(),
            email: claims.email.clone(),
            display_name: display_name.map(str::to_string),
            csrf_token: csrf_token.clone(),
            expires_at,
        };
        let key = redis.key(&format!("sys:session:{}", hex_encode(&token_hash)));
        if let Err(err) = redis
            .set_json_ex(
                &key,
                &cached,
                u64::try_from(SESSION_TTL_SECS).unwrap_or(28_800),
            )
            .await
        {
            warn!(error = %err, "failed to cache admin session in Redis");
        }
    }

    Ok(CreatedSession {
        raw_token,
        csrf_token,
        expires_at,
    })
}

/// Loads an active, unexpired admin session and verifies it still matches the configured
/// `expected_issuer` and `expected_sub`.
///
/// # Errors
/// Returns an error if the database query fails.
pub async fn load_valid_admin_session(
    pool: &PgPool,
    redis: Option<&RedisStore>,
    raw_token: &str,
    expected_issuer: &str,
    expected_sub: &str,
) -> Result<Option<AdminSession>> {
    let token_hash = sha256(raw_token.as_bytes());
    let cache_key = redis.map(|r| r.key(&format!("sys:session:{}", hex_encode(&token_hash))));

    if let (Some(redis), Some(key)) = (redis, &cache_key) {
        match redis.get_json::<AdminSession>(key).await {
            Ok(Some(session)) => {
                if session.expires_at > Utc::now()
                    && session.issuer == expected_issuer
                    && session.subject == expected_sub
                {
                    return Ok(Some(session));
                }
                let _ = redis.del(key).await;
            }
            Ok(None) => {}
            Err(err) => {
                warn!(error = %err, "failed to read admin session from Redis; falling back to PostgreSQL");
            }
        }
    }

    let row = sqlx::query(
        "SELECT s.id, s.issuer, s.subject, s.csrf_token, s.expires_at,
                i.email, i.display_name
         FROM admin_sessions s
         JOIN oidc_identities i ON i.id = s.identity_id
         WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > NOW()",
    )
    .bind(token_hash.as_slice())
    .fetch_optional(pool)
    .await
    .context("failed to query admin session")?;

    let Some(row) = row else {
        return Ok(None);
    };

    let issuer: String = row.get("issuer");
    let subject: String = row.get("subject");
    if issuer != expected_issuer || subject != expected_sub {
        return Ok(None);
    }

    let session = AdminSession {
        session_id: row.get("id"),
        issuer,
        subject,
        email: row.get("email"),
        display_name: row.get("display_name"),
        csrf_token: row.get("csrf_token"),
        expires_at: row.get("expires_at"),
    };

    if let (Some(redis), Some(key)) = (redis, &cache_key) {
        let remaining = (session.expires_at - Utc::now()).num_seconds();
        if remaining > 0
            && let Ok(ttl) = u64::try_from(remaining)
            && let Err(err) = redis.set_json_ex(key, &session, ttl).await
        {
            warn!(error = %err, "failed to backfill admin session into Redis");
        }
    }

    Ok(Some(session))
}

/// Revokes an admin session by its raw cookie token.
///
/// # Errors
/// Returns an error if the database update fails.
pub async fn revoke_session(
    pool: &PgPool,
    redis: Option<&RedisStore>,
    raw_token: &str,
) -> Result<()> {
    let token_hash = sha256(raw_token.as_bytes());
    if let Some(redis) = redis {
        let key = redis.key(&format!("sys:session:{}", hex_encode(&token_hash)));
        if let Err(err) = redis.del(&key).await {
            warn!(error = %err, "failed to delete admin session from Redis");
        }
    }

    sqlx::query(
        "UPDATE admin_sessions SET revoked_at = NOW()
         WHERE token_hash = $1 AND revoked_at IS NULL",
    )
    .bind(token_hash.as_slice())
    .execute(pool)
    .await
    .context("failed to revoke admin session")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_return_to_allows_only_in_site_paths() {
        assert_eq!(sanitize_return_to(None), "/");
        assert_eq!(sanitize_return_to(Some("")), "/");
        assert_eq!(
            sanitize_return_to(Some("/catalog/providers?q=a")),
            "/catalog/providers?q=a"
        );
        assert_eq!(sanitize_return_to(Some("https://evil.example/")), "/");
        assert_eq!(sanitize_return_to(Some("//evil.example/")), "/");
        assert_eq!(sanitize_return_to(Some("/\\evil.example")), "/");
        assert_eq!(sanitize_return_to(Some("/ok\r\nSet-Cookie: bad")), "/");
    }

    #[test]
    fn extracts_session_cookie_from_header() {
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::COOKIE,
            axum::http::HeaderValue::from_static("other=1; linguist_session=abc123; foo=bar"),
        );
        assert_eq!(extract_session_cookie(&headers).as_deref(), Some("abc123"));
    }
}
