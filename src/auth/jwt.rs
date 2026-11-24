//! Base64url helpers, PKCE/CSPRNG utilities, and OIDC ID token JWKS verification.

use anyhow::{Context, Result, bail};
use ring::digest;
use ring::rand::{SecureRandom, SystemRandom};
use ring::signature::{self, RsaPublicKeyComponents, UnparsedPublicKey};
use serde::{Deserialize, Serialize};

/// Allowed clock skew in seconds when validating `exp` and `iat`.
const CLOCK_SKEW_SECS: i64 = 60;

/// JSON Web Key Set returned by an OIDC provider's `jwks_uri`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Jwks {
    /// List of public keys published by the identity provider.
    pub keys: Vec<Jwk>,
}

/// Single JSON Web Key entry supporting RSA and EC (P-256 / P-384) keys.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Jwk {
    /// Key type (`RSA` or `EC`).
    pub kty: String,
    /// Optional key identifier.
    #[serde(default)]
    pub kid: Option<String>,
    /// Optional intended key usage (`sig`).
    #[serde(rename = "use", default)]
    pub key_use: Option<String>,
    /// Optional algorithm hint.
    #[serde(default)]
    pub alg: Option<String>,
    /// RSA modulus (base64url big-endian).
    #[serde(default)]
    pub n: Option<String>,
    /// RSA exponent (base64url big-endian).
    #[serde(default)]
    pub e: Option<String>,
    /// EC curve name (`P-256`, `P-384`).
    #[serde(default)]
    pub crv: Option<String>,
    /// EC x coordinate (base64url big-endian).
    #[serde(default)]
    pub x: Option<String>,
    /// EC y coordinate (base64url big-endian).
    #[serde(default)]
    pub y: Option<String>,
}

/// Validated OIDC ID token claims.
#[derive(Debug, Clone, Deserialize)]
pub struct IdTokenClaims {
    /// Token issuer URL.
    pub iss: String,
    /// Subject identifier.
    pub sub: String,
    /// Audience (single string or array of strings).
    pub aud: Audience,
    /// Authorized party when multiple audiences are present.
    #[serde(default)]
    pub azp: Option<String>,
    /// Expiration timestamp (Unix seconds).
    pub exp: i64,
    /// Nonce bound to the login transaction.
    #[serde(default)]
    pub nonce: Option<String>,
    /// Optional email claim for audit/display.
    #[serde(default)]
    pub email: Option<String>,
    /// Optional display name claim for audit/display.
    #[serde(default)]
    pub name: Option<String>,
    /// Optional preferred username fallback for display.
    #[serde(default)]
    pub preferred_username: Option<String>,
}

/// OIDC `aud` claim representation supporting either a single string or a list.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum Audience {
    /// Single audience string.
    Single(String),
    /// Multiple audience strings.
    Multiple(Vec<String>),
}

impl Audience {
    /// Returns true if `expected` is present in `aud`.
    fn contains(&self, expected: &str) -> bool {
        match self {
            Self::Single(value) => value == expected,
            Self::Multiple(values) => values.iter().any(|value| value == expected),
        }
    }

    /// Returns true if more than one audience is present.
    fn is_multiple(&self) -> bool {
        matches!(self, Self::Multiple(values) if values.len() > 1)
    }
}

/// Minimal JWT header fields needed for signature verification.
#[derive(Debug, Deserialize)]
struct JwtHeader {
    /// JWS signing algorithm.
    alg: String,
    /// Optional key ID.
    #[serde(default)]
    kid: Option<String>,
}

/// Generates `num_bytes` of cryptographically random bytes encoded as unpadded base64url.
///
/// # Errors
/// Returns an error if the system CSPRNG fails.
pub fn random_token_b64(num_bytes: usize) -> Result<String> {
    let rng = SystemRandom::new();
    let mut buf = vec![0u8; num_bytes];
    rng.fill(&mut buf)
        .map_err(|_| anyhow::anyhow!("CSPRNG failed"))?;
    Ok(base64url_encode(&buf))
}

/// Computes SHA-256 over `data`.
#[must_use]
pub fn sha256(data: &[u8]) -> [u8; 32] {
    let digest = digest::digest(&digest::SHA256, data);
    let mut out = [0u8; 32];
    out.copy_from_slice(digest.as_ref());
    out
}

/// Computes the PKCE `S256` code challenge for `verifier`.
#[must_use]
pub fn pkce_code_challenge(verifier: &str) -> String {
    base64url_encode(&sha256(verifier.as_bytes()))
}

/// Verifies an OIDC ID token signature against `jwks` and validates standard claims.
///
/// # Errors
/// Returns an error if the JWT is malformed, signature verification fails, or any
/// required claim (`iss`, `sub`, `aud`, `exp`, `nonce`) fails validation.
pub fn verify_id_token(
    id_token: &str,
    jwks: &Jwks,
    expected_issuer: &str,
    expected_client_id: &str,
    expected_nonce: &str,
    now_unix: i64,
) -> Result<IdTokenClaims> {
    let mut parts = id_token.split('.');
    let header_b64 = parts.next().context("missing JWT header")?;
    let payload_b64 = parts.next().context("missing JWT payload")?;
    let sig_b64 = parts.next().context("missing JWT signature")?;
    if parts.next().is_some() {
        bail!("unexpected extra JWT segments");
    }

    let header_bytes = base64url_decode(header_b64).context("invalid JWT header base64url")?;
    let header: JwtHeader =
        serde_json::from_slice(&header_bytes).context("invalid JWT header JSON")?;
    if header.alg.eq_ignore_ascii_case("none") {
        bail!("unsigned JWTs are rejected");
    }

    let sig_bytes = base64url_decode(sig_b64).context("invalid JWT signature base64url")?;
    let signing_input = format!("{header_b64}.{payload_b64}");

    let candidates: Vec<&Jwk> = jwks
        .keys
        .iter()
        .filter(|key| key.key_use.as_deref().is_none_or(|u| u == "sig"))
        .filter(|key| match (&header.kid, &key.kid) {
            (Some(want), Some(have)) => want == have,
            (Some(_), None) => false,
            (None, _) => true,
        })
        .collect();

    if candidates.is_empty() {
        bail!("no matching JWK found for token");
    }

    let mut verified = false;
    for key in candidates {
        if verify_jws_with_key(&header.alg, key, signing_input.as_bytes(), &sig_bytes).is_ok() {
            verified = true;
            break;
        }
    }
    if !verified {
        bail!("ID token signature verification failed");
    }

    let payload_bytes = base64url_decode(payload_b64).context("invalid JWT payload base64url")?;
    let claims: IdTokenClaims =
        serde_json::from_slice(&payload_bytes).context("invalid JWT claims JSON")?;

    if claims.iss != expected_issuer {
        bail!("ID token issuer mismatch");
    }
    if claims.sub.trim().is_empty() {
        bail!("ID token subject is empty");
    }
    if !claims.aud.contains(expected_client_id) {
        bail!("ID token audience mismatch");
    }
    if claims.aud.is_multiple() && claims.azp.as_deref() != Some(expected_client_id) {
        bail!("ID token authorized party mismatch");
    }
    if claims.exp + CLOCK_SKEW_SECS < now_unix {
        bail!("ID token is expired");
    }
    if claims.nonce.as_deref() != Some(expected_nonce) {
        bail!("ID token nonce mismatch");
    }

    Ok(claims)
}

/// Verifies a JWS signature against a single JWK.
fn verify_jws_with_key(alg: &str, key: &Jwk, message: &[u8], sig: &[u8]) -> Result<()> {
    if let Some(key_alg) = &key.alg
        && key_alg != alg
    {
        bail!("JWK algorithm mismatch");
    }

    match alg {
        "RS256" | "RS384" | "RS512" | "PS256" | "PS384" | "PS512" => {
            if key.kty != "RSA" {
                bail!("expected RSA key for {alg}");
            }
            let n = base64url_decode(key.n.as_deref().context("missing RSA n")?)?;
            let e = base64url_decode(key.e.as_deref().context("missing RSA e")?)?;
            let algorithm: &signature::RsaParameters = match alg {
                "RS256" => &signature::RSA_PKCS1_2048_8192_SHA256,
                "RS384" => &signature::RSA_PKCS1_2048_8192_SHA384,
                "RS512" => &signature::RSA_PKCS1_2048_8192_SHA512,
                "PS256" => &signature::RSA_PSS_2048_8192_SHA256,
                "PS384" => &signature::RSA_PSS_2048_8192_SHA384,
                "PS512" => &signature::RSA_PSS_2048_8192_SHA512,
                _ => bail!("unsupported RSA alg {alg}"),
            };
            RsaPublicKeyComponents { n: &n, e: &e }
                .verify(algorithm, message, sig)
                .map_err(|_| anyhow::anyhow!("RSA signature verification failed"))
        }
        "ES256" | "ES384" => {
            if key.kty != "EC" {
                bail!("expected EC key for {alg}");
            }
            let (expected_crv, coord_len, algorithm) = match alg {
                "ES256" => ("P-256", 32usize, &signature::ECDSA_P256_SHA256_FIXED),
                "ES384" => ("P-384", 48usize, &signature::ECDSA_P384_SHA384_FIXED),
                _ => bail!("unsupported EC alg {alg}"),
            };
            if key.crv.as_deref() != Some(expected_crv) {
                bail!("EC curve mismatch");
            }
            let x = base64url_decode(key.x.as_deref().context("missing EC x")?)?;
            let y = base64url_decode(key.y.as_deref().context("missing EC y")?)?;
            let mut point = Vec::with_capacity(1 + coord_len * 2);
            point.push(0x04);
            append_padded(&mut point, &x, coord_len)?;
            append_padded(&mut point, &y, coord_len)?;
            UnparsedPublicKey::new(algorithm, &point)
                .verify(message, sig)
                .map_err(|_| anyhow::anyhow!("ECDSA signature verification failed"))
        }
        _ => bail!("unsupported JWS algorithm '{alg}'"),
    }
}

/// Appends a big-endian coordinate left-padded with zeros to `len` bytes.
fn append_padded(out: &mut Vec<u8>, bytes: &[u8], len: usize) -> Result<()> {
    if bytes.len() > len {
        bail!("EC coordinate exceeds expected length");
    }
    for _ in 0..(len - bytes.len()) {
        out.push(0);
    }
    out.extend_from_slice(bytes);
    Ok(())
}

/// Encodes `input` as unpadded URL-safe base64.
#[must_use]
pub fn base64url_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = u32::from(*chunk.get(1).unwrap_or(&0));
        let b2 = u32::from(*chunk.get(2).unwrap_or(&0));
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((triple >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((triple >> 12) & 0x3f) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[((triple >> 6) & 0x3f) as usize] as char);
        }
        if chunk.len() > 2 {
            out.push(TABLE[(triple & 0x3f) as usize] as char);
        }
    }
    out
}

/// Decodes unpadded (or padded) URL-safe base64 into raw bytes.
///
/// # Errors
/// Returns an error if `input` contains invalid base64url characters or length.
pub fn base64url_decode(input: &str) -> Result<Vec<u8>> {
    let trimmed = input.trim_end_matches('=');
    if trimmed.len() % 4 == 1 {
        bail!("invalid base64url length");
    }
    let mut vals = Vec::with_capacity(trimmed.len());
    for byte in trimmed.bytes() {
        let v = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => bail!("invalid base64url character"),
        };
        vals.push(v);
    }
    let mut out = Vec::with_capacity(vals.len() * 3 / 4);
    for chunk in vals.chunks(4) {
        let v0 = u32::from(chunk[0]);
        let v1 = u32::from(chunk[1]);
        out.push(u8::try_from((v0 << 2) | (v1 >> 4))?);
        if let Some(&v2_u8) = chunk.get(2) {
            let v2 = u32::from(v2_u8);
            out.push(u8::try_from(((v1 & 0x0f) << 4) | (v2 >> 2))?);
            if let Some(&v3_u8) = chunk.get(3) {
                let v3 = u32::from(v3_u8);
                out.push(u8::try_from(((v2 & 0x03) << 6) | v3)?);
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair, KeyPair};
    use serde_json::json;

    #[test]
    fn pkce_and_base64url_roundtrip() {
        let raw = b"hello-oidc-world!";
        let enc = base64url_encode(raw);
        let dec = base64url_decode(&enc).ok();
        assert_eq!(dec.as_deref(), Some(raw.as_slice()));

        let challenge = pkce_code_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
        assert_eq!(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn verifies_es256_id_token_and_rejects_mismatches() {
        let rng = SystemRandom::new();
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng);
        assert!(pkcs8.is_ok());
        let pkcs8 = pkcs8.unwrap_or_else(|_| unreachable!());
        let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng);
        assert!(pair.is_ok());
        let pair = pair.unwrap_or_else(|_| unreachable!());
        let pub_bytes = pair.public_key().as_ref();
        assert_eq!(pub_bytes.len(), 65);

        let jwks = Jwks {
            keys: vec![Jwk {
                kty: "EC".to_string(),
                kid: Some("k1".to_string()),
                key_use: Some("sig".to_string()),
                alg: Some("ES256".to_string()),
                n: None,
                e: None,
                crv: Some("P-256".to_string()),
                x: Some(base64url_encode(&pub_bytes[1..33])),
                y: Some(base64url_encode(&pub_bytes[33..65])),
            }],
        };

        let sign = |claims: serde_json::Value| -> String {
            let header = base64url_encode(br#"{"alg":"ES256","kid":"k1","typ":"JWT"}"#);
            let payload = base64url_encode(claims.to_string().as_bytes());
            let input = format!("{header}.{payload}");
            let sig = pair
                .sign(&rng, input.as_bytes())
                .unwrap_or_else(|_| unreachable!());
            format!("{input}.{}", base64url_encode(sig.as_ref()))
        };

        let valid_jwt = sign(json!({
            "iss": "https://idp.example/oidc",
            "sub": "admin-123",
            "aud": "linguist-web",
            "exp": 2_000_000_000i64,
            "nonce": "n-1",
            "email": "admin@example.com"
        }));

        let claims = verify_id_token(
            &valid_jwt,
            &jwks,
            "https://idp.example/oidc",
            "linguist-web",
            "n-1",
            1_999_999_000,
        );
        assert!(claims.is_ok());

        // Wrong issuer
        assert!(
            verify_id_token(
                &valid_jwt,
                &jwks,
                "https://other.example/oidc",
                "linguist-web",
                "n-1",
                1_999_999_000,
            )
            .is_err()
        );
        // Wrong nonce
        assert!(
            verify_id_token(
                &valid_jwt,
                &jwks,
                "https://idp.example/oidc",
                "linguist-web",
                "n-2",
                1_999_999_000,
            )
            .is_err()
        );
        // Expired
        assert!(
            verify_id_token(
                &valid_jwt,
                &jwks,
                "https://idp.example/oidc",
                "linguist-web",
                "n-1",
                2_000_000_200,
            )
            .is_err()
        );
    }
}
