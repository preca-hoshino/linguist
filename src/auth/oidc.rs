//! OIDC discovery, JWKS caching, authorization URL generation, and token exchange.

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use reqwest::Url;
use serde::Deserialize;
use tokio::sync::RwLock;

use crate::auth::jwt::{IdTokenClaims, Jwks, verify_id_token};
use crate::config::ValidatedOidcConfig;

/// TTL for cached OIDC discovery documents.
const DISCOVERY_TTL: Duration = Duration::from_secs(3600);

/// TTL for cached JWKS key sets.
const JWKS_TTL: Duration = Duration::from_mins(15);

/// Subset of the `OpenID` Connect Discovery 1.0 metadata document.
#[derive(Debug, Clone, Deserialize)]
pub struct OidcDiscovery {
    /// Issuer identifier; must match configured `[oidc].issuer`.
    pub issuer: String,
    /// Authorization endpoint URL.
    pub authorization_endpoint: String,
    /// Token endpoint URL.
    pub token_endpoint: String,
    /// JSON Web Key Set URL.
    pub jwks_uri: String,
}

/// Token endpoint response fields needed for OIDC authorization code flow.
#[derive(Debug, Deserialize)]
struct TokenResponse {
    /// Signed OIDC ID token (JWT).
    id_token: Option<String>,
}

/// Cached discovery document and JWKS keys.
#[derive(Debug, Default)]
struct OidcCache {
    /// Cached discovery metadata and fetch timestamp.
    discovery: Option<(OidcDiscovery, Instant)>,
    /// Cached JWKS and fetch timestamp.
    jwks: Option<(Jwks, Instant)>,
}

/// OIDC client performing discovery, PKCE authorization redirects, and ID token verification.
#[derive(Debug, Clone)]
pub struct OidcClient {
    /// Validated static configuration.
    config: ValidatedOidcConfig,
    /// Dedicated short-timeout HTTP client for `IdP` communication.
    http: reqwest::Client,
    /// In-memory discovery and JWKS cache.
    cache: Arc<RwLock<OidcCache>>,
}

impl OidcClient {
    /// Creates a new `OidcClient` with a 10-second timeout for `IdP` requests.
    ///
    /// # Errors
    /// Returns an error if the HTTP client fails to initialize.
    pub fn new(config: ValidatedOidcConfig) -> Result<Self> {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .context("failed to build OIDC HTTP client")?;
        Ok(Self {
            config,
            http,
            cache: Arc::new(RwLock::new(OidcCache::default())),
        })
    }

    /// Returns the validated OIDC configuration.
    #[must_use]
    pub fn config(&self) -> &ValidatedOidcConfig {
        &self.config
    }

    /// Builds the `IdP` authorization URL for Authorization Code + PKCE (`S256`).
    ///
    /// # Errors
    /// Returns an error if OIDC discovery fails or the authorization endpoint URL is invalid.
    pub async fn build_authorization_url(
        &self,
        state: &str,
        nonce: &str,
        code_challenge: &str,
    ) -> Result<String> {
        let discovery = self.discovery().await?;
        let mut url = Url::parse(&discovery.authorization_endpoint)
            .context("invalid authorization_endpoint in OIDC discovery")?;
        url.query_pairs_mut()
            .append_pair("response_type", "code")
            .append_pair("client_id", &self.config.client_id)
            .append_pair("redirect_uri", &self.config.redirect_uri)
            .append_pair("scope", "openid profile email")
            .append_pair("state", state)
            .append_pair("nonce", nonce)
            .append_pair("code_challenge", code_challenge)
            .append_pair("code_challenge_method", "S256");
        Ok(url.to_string())
    }

    /// Exchanges an authorization `code` for an `id_token` and verifies its signature and claims.
    ///
    /// # Errors
    /// Returns an error if discovery, token exchange, JWKS fetch, or ID token verification fails.
    pub async fn exchange_and_verify_code(
        &self,
        code: &str,
        code_verifier: &str,
        expected_nonce: &str,
    ) -> Result<IdTokenClaims> {
        let discovery = self.discovery().await?;
        let response = self
            .http
            .post(&discovery.token_endpoint)
            .form(&[
                ("grant_type", "authorization_code"),
                ("code", code),
                ("redirect_uri", self.config.redirect_uri.as_str()),
                ("client_id", self.config.client_id.as_str()),
                ("client_secret", self.config.client_secret.as_str()),
                ("code_verifier", code_verifier),
            ])
            .send()
            .await
            .context("OIDC token endpoint request failed")?;

        if !response.status().is_success() {
            bail!("OIDC token endpoint returned HTTP {}", response.status());
        }

        let token_resp: TokenResponse = response
            .json()
            .await
            .context("invalid OIDC token endpoint JSON response")?;
        let id_token = token_resp
            .id_token
            .as_deref()
            .filter(|t| !t.is_empty())
            .context("OIDC token response did not include id_token")?;

        let now_unix = chrono::Utc::now().timestamp();
        let jwks = self.jwks(&discovery.jwks_uri, false).await?;
        if let Ok(claims) = verify_id_token(
            id_token,
            &jwks,
            &self.config.issuer,
            &self.config.client_id,
            expected_nonce,
            now_unix,
        ) {
            Ok(claims)
        } else {
            // Retry once with freshly fetched JWKS in case the IdP rotated keys.
            let fresh_jwks = self.jwks(&discovery.jwks_uri, true).await?;
            verify_id_token(
                id_token,
                &fresh_jwks,
                &self.config.issuer,
                &self.config.client_id,
                expected_nonce,
                now_unix,
            )
        }
    }

    /// Loads the OIDC discovery document from cache or `<issuer>/.well-known/openid-configuration`.
    async fn discovery(&self) -> Result<OidcDiscovery> {
        {
            let guard = self.cache.read().await;
            if let Some((doc, fetched_at)) = &guard.discovery
                && fetched_at.elapsed() < DISCOVERY_TTL
            {
                return Ok(doc.clone());
            }
        }

        let base = self.config.issuer.trim_end_matches('/');
        let url = format!("{base}/.well-known/openid-configuration");
        let resp = self
            .http
            .get(&url)
            .send()
            .await
            .context("failed to fetch OIDC discovery document")?;
        if !resp.status().is_success() {
            bail!("OIDC discovery endpoint returned HTTP {}", resp.status());
        }
        let doc: OidcDiscovery = resp
            .json()
            .await
            .context("invalid OIDC discovery JSON document")?;
        if doc.issuer != self.config.issuer {
            bail!(
                "OIDC discovery issuer '{}' does not match configured issuer '{}'",
                doc.issuer,
                self.config.issuer
            );
        }

        let mut guard = self.cache.write().await;
        guard.discovery = Some((doc.clone(), Instant::now()));
        Ok(doc)
    }

    /// Loads the JWKS key set from cache or `jwks_uri`.
    async fn jwks(&self, jwks_uri: &str, force_refresh: bool) -> Result<Jwks> {
        if !force_refresh {
            let guard = self.cache.read().await;
            if let Some((keys, fetched_at)) = &guard.jwks
                && fetched_at.elapsed() < JWKS_TTL
            {
                return Ok(keys.clone());
            }
        }

        let resp = self
            .http
            .get(jwks_uri)
            .send()
            .await
            .context("failed to fetch OIDC JWKS")?;
        if !resp.status().is_success() {
            bail!("OIDC JWKS endpoint returned HTTP {}", resp.status());
        }
        let jwks: Jwks = resp.json().await.context("invalid OIDC JWKS JSON")?;

        let mut guard = self.cache.write().await;
        guard.jwks = Some((jwks.clone(), Instant::now()));
        Ok(jwks)
    }
}
