//! Encryption and authentication for credentials stored in the catalog.

use std::fmt;

use anyhow::{Context, Result, anyhow, ensure};
use ring::aead::{self, Aad, LessSafeKey, Nonce, UnboundKey};
use ring::hmac;
use ring::rand::{SecureRandom, SystemRandom};

/// Context-separated keys derived from the instance's catalog master key.
#[derive(Clone)]
pub struct CatalogSecrets {
    /// Authentication key for project credentials.
    projects: hmac::Key,
    /// Authentication key for configuration fingerprints and master key checks.
    fingerprints: hmac::Key,
    /// Key material for authenticated encryption of upstream credentials.
    upstream: [u8; 32],
}

impl fmt::Debug for CatalogSecrets {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CatalogSecrets").finish_non_exhaustive()
    }
}

impl CatalogSecrets {
    /// Reads the shared 32-byte hex master key from `LINGUIST_CATALOG_KEY`.
    ///
    /// # Errors
    /// Returns an error if the key is missing or malformed.
    pub fn from_env() -> Result<Self> {
        let encoded = std::env::var("LINGUIST_CATALOG_KEY")
            .context("set LINGUIST_CATALOG_KEY to a shared random 32-byte hex key")?;
        Self::from_hex(&encoded)
    }

    /// Constructs catalog keys from 64 hexadecimal characters.
    ///
    /// # Errors
    /// Returns an error if the encoding is malformed.
    pub fn from_hex(encoded: &str) -> Result<Self> {
        let bytes = encoded.as_bytes();
        ensure!(
            bytes.len() == 64,
            "LINGUIST_CATALOG_KEY must be 64 hex characters"
        );
        let mut master = [0; 32];
        for (dest, [high, low]) in master.iter_mut().zip(bytes.as_chunks::<2>().0) {
            *dest = hex_digit(*high)? * 16 + hex_digit(*low)?;
        }
        let key = hmac::Key::new(hmac::HMAC_SHA256, &master);
        let derive = |label| tag_bytes(hmac::sign(&key, label));
        Ok(Self {
            projects: hmac::Key::new(hmac::HMAC_SHA256, &derive(b"linguist project keys v1")),
            fingerprints: hmac::Key::new(hmac::HMAC_SHA256, &derive(b"linguist catalog v1")),
            upstream: derive(b"linguist upstream keys v1"),
        })
    }

    /// Authenticates canonical catalog contents without storing plaintext fingerprints.
    pub(super) fn fingerprint(&self, bytes: &[u8]) -> [u8; 32] {
        tag_bytes(hmac::sign(&self.fingerprints, bytes))
    }

    /// Identifies the shared master key without revealing it.
    pub(in crate::catalog) fn key_tag(&self) -> [u8; 32] {
        self.fingerprint(b"linguist catalog key check")
    }

    /// Computes the digest stored for a project bearer key.
    pub(in crate::catalog) fn digest_project(&self, project_id: &str, token: &str) -> [u8; 32] {
        tag_bytes(hmac::sign(
            &self.projects,
            &project_message(project_id, token),
        ))
    }

    /// Checks a supplied project key against its stored digest.
    #[allow(dead_code)]
    pub(in crate::catalog) fn verify_project(
        &self,
        project_id: &str,
        token: &str,
        digest: &[u8],
    ) -> bool {
        hmac::verify(&self.projects, &project_message(project_id, token), digest).is_ok()
    }

    /// Encrypts one provider key with a random nonce bound to the provider ID.
    pub(in crate::catalog) fn seal_provider(
        &self,
        provider_id: &str,
        key: &str,
    ) -> Result<Option<Vec<u8>>> {
        if key.is_empty() {
            return Ok(None);
        }
        let mut nonce = [0; aead::NONCE_LEN];
        SystemRandom::new()
            .fill(&mut nonce)
            .map_err(|_| anyhow!("catalog nonce generation failed"))?;
        let mut data = key.as_bytes().to_vec();
        self.aead_key()?
            .seal_in_place_append_tag(
                Nonce::assume_unique_for_key(nonce),
                Aad::from(provider_id.as_bytes()),
                &mut data,
            )
            .map_err(|_| anyhow!("catalog credential encryption failed"))?;
        Ok(Some([nonce.as_slice(), &data].concat()))
    }

    /// Authenticates and decrypts a stored provider key.
    pub(super) fn open_provider(
        &self,
        provider_id: &str,
        stored: Option<Vec<u8>>,
    ) -> Result<String> {
        let Some(mut data) = stored else {
            return Ok(String::new());
        };
        let (nonce, ciphertext) = data
            .split_at_mut_checked(aead::NONCE_LEN)
            .context("invalid encrypted catalog credential")?;
        let nonce = Nonce::try_assume_unique_for_key(nonce)
            .map_err(|_| anyhow!("invalid catalog credential nonce"))?;
        let bytes = self
            .aead_key()?
            .open_in_place(nonce, Aad::from(provider_id.as_bytes()), ciphertext)
            .map_err(|_| anyhow!("cannot unlock catalog credential"))?;
        String::from_utf8(bytes.to_vec()).context("invalid catalog credential encoding")
    }

    /// Builds a `ring` key from the derived encryption material.
    fn aead_key(&self) -> Result<LessSafeKey> {
        UnboundKey::new(&aead::CHACHA20_POLY1305, &self.upstream)
            .map(LessSafeKey::new)
            .map_err(|_| anyhow!("invalid catalog encryption key"))
    }
}

/// Compares legacy and console tokens without short-circuiting on a differing byte.
pub(crate) fn tokens_equal(a: &[u8], b: &[u8]) -> bool {
    let mut diff = a.len() ^ b.len();
    for i in 0..a.len().max(b.len()) {
        diff |= usize::from(a.get(i).copied().unwrap_or(0) ^ b.get(i).copied().unwrap_or(0));
    }
    diff == 0
}

/// Separates the project namespace from the raw token (project IDs exclude NUL).
fn project_message(project_id: &str, token: &str) -> Vec<u8> {
    [project_id.as_bytes(), &[0], token.as_bytes()].concat()
}

/// Copies a SHA-256 HMAC tag to a fixed buffer.
fn tag_bytes(tag: hmac::Tag) -> [u8; 32] {
    let mut bytes = [0; 32];
    bytes.copy_from_slice(tag.as_ref());
    bytes
}

/// Decodes one ASCII hexadecimal digit without including key material in errors.
fn hex_digit(byte: u8) -> Result<u8> {
    (char::from(byte))
        .to_digit(16)
        .and_then(|n| u8::try_from(n).ok())
        .context("LINGUIST_CATALOG_KEY must be 64 hex characters")
}
