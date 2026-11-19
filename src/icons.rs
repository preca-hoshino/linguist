//! `LobeHub` SVG icon pack synchronization and local resolution.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use flate2::read::GzDecoder;
use serde::Deserialize;
use tar::Archive;
use tracing::{info, warn};

use crate::config::IconsConfig;

/// NPM registry latest package metadata subset used to locate the tarball URL.
#[derive(Debug, Deserialize)]
struct RegistryLatestMeta {
    /// Distribution metadata block.
    dist: RegistryDistMeta,
}

/// Distribution metadata containing the `.tgz` tarball download URL.
#[derive(Debug, Deserialize)]
struct RegistryDistMeta {
    /// Direct URL to the `.tgz` tarball.
    tarball: String,
}

/// Core fallback SVG icons written/served if offline or missing from the downloaded pack.
const FALLBACK_SVGS: &[(&str, &str)] = &[
    (
        "deepseek-color",
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><rect width="24" height="24" rx="6" fill="#4D6BFE"/><path d="M6.5 13.2c1.2-3.4 4.1-5.4 7.3-4.6 2.1.5 3.6 2.1 4.1 4.2-.9-.7-2.1-.9-3.1-.4-1 .5-1.5 1.5-1.4 2.6-2.4.7-5 .1-6.9-1.8Z" fill="#fff"/></svg>"##,
    ),
    (
        "opencode",
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><rect x="2" y="2" width="20" height="20" rx="5" fill="#111827"/><path d="M8.5 8.5h7v7h-7z" stroke="#fff" stroke-width="2"/></svg>"##,
    ),
    (
        "qwen-color",
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><rect width="24" height="24" rx="6" fill="#6366F1"/><path d="M12 6l5.2 3v6L12 18l-5.2-3V9L12 6z" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/></svg>"##,
    ),
    (
        "openai",
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="#111827" stroke-width="1.8"/><circle cx="12" cy="12" r="3.5" fill="#111827"/></svg>"##,
    ),
    (
        "gemini-color",
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><rect width="24" height="24" rx="6" fill="#1A73E8"/><path d="M12 4.5C12.7 8.7 15.3 11.3 19.5 12C15.3 12.7 12.7 15.3 12 19.5C11.3 15.3 8.7 12.7 4.5 12C8.7 11.3 11.3 8.7 12 4.5Z" fill="#fff"/></svg>"##,
    ),
    (
        "claude-color",
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><rect width="24" height="24" rx="6" fill="#D97757"/><path d="M12 5v14M5 12h14M7.2 7.2l9.6 9.6M16.8 7.2l-9.6 9.6" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg>"##,
    ),
    (
        "grok",
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><rect x="2" y="2" width="20" height="20" rx="5" fill="#111827"/><path d="M7.5 16.5L16.5 7.5M9 7.5h7.5V15" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>"##,
    ),
    (
        "githubcopilot",
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><rect x="2" y="2" width="20" height="20" rx="5" fill="#111827"/><rect x="6.5" y="9" width="11" height="7" rx="3" stroke="#fff" stroke-width="1.8"/><circle cx="10" cy="12.5" r="1" fill="#fff"/><circle cx="14" cy="12.5" r="1" fill="#fff"/></svg>"##,
    ),
    (
        "cursor",
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><rect x="2" y="2" width="20" height="20" rx="5" fill="#111827"/><path d="M8 6l9 6.5-4.5 1.2L11 18 8 6z" fill="#fff"/></svg>"##,
    ),
    (
        "kimi-color",
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><rect width="24" height="24" rx="6" fill="#0EA5E9"/><path d="M8 7v10M16 7l-6 5 6 5" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>"##,
    ),
    (
        "minimax-color",
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><rect width="24" height="24" rx="6" fill="#F43F5E"/><path d="M6.5 15.5v-7l3.5 4 2-4 2 4 3.5-4v7" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>"##,
    ),
    (
        "zhipu-color",
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><rect width="24" height="24" rx="6" fill="#3B82F6"/><path d="M7.5 8h9l-9 8h9" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>"##,
    ),
    (
        "codex-color",
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><rect width="24" height="24" rx="6" fill="#10B981"/><path d="M9 8.5L5.5 12 9 15.5M15 8.5l3.5 3.5L15 15.5M13 7.5l-2 9" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>"##,
    ),
    (
        "copilot-color",
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><rect width="24" height="24" rx="6" fill="#4B7FFF"/><rect x="6.5" y="9" width="11" height="6.5" rx="3" stroke="#fff" stroke-width="1.8"/><circle cx="10" cy="12.2" r="1" fill="#fff"/><circle cx="14" cy="12.2" r="1" fill="#fff"/></svg>"##,
    ),
    (
        "alibabacloud-color",
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><rect width="24" height="24" rx="6" fill="#FF6A00"/><path d="M7 9.5h10M7 14.5h10M9.5 12h5" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>"##,
    ),
    (
        "xiaomi-color",
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><rect width="24" height="24" rx="6" fill="#FF6900"/><path d="M7 16V9h5.5a2 2 0 0 1 2 2v5M10.5 16v-4M17 9v7" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>"##,
    ),
    (
        "hunyuan-color",
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><rect width="24" height="24" rx="6" fill="#2563EB"/><path d="M7.5 7.5v9M16.5 7.5v9M7.5 12h9" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>"##,
    ),
];

/// Downloads `@lobehub/icons-static-svg` from the configured NPM registry and
/// extracts all `.svg` assets into `config.lobe_icons_dir`.
///
/// # Errors
/// Returns an error if directories cannot be created or registry/tarball extraction fails.
pub async fn sync_icons(config: &IconsConfig) -> Result<usize> {
    fs::create_dir_all(&config.lobe_icons_dir).with_context(|| {
        format!(
            "failed to create lobe icons dir {}",
            config.lobe_icons_dir.display()
        )
    })?;
    fs::create_dir_all(&config.custom_icons_dir).with_context(|| {
        format!(
            "failed to create custom icons dir {}",
            config.custom_icons_dir.display()
        )
    })?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .context("failed to initialize HTTP client for icon sync")?;

    info!(url = %config.registry_url, "fetching @lobehub/icons-static-svg registry metadata");
    let meta: RegistryLatestMeta = client
        .get(&config.registry_url)
        .send()
        .await
        .context("failed to request LobeHub icon registry")?
        .error_for_status()
        .context("LobeHub icon registry returned HTTP error")?
        .json()
        .await
        .context("failed to parse LobeHub icon registry JSON")?;

    info!(tarball = %meta.dist.tarball, "downloading LobeHub SVG tarball");
    let tgz_bytes = client
        .get(&meta.dist.tarball)
        .send()
        .await
        .context("failed to download LobeHub SVG tarball")?
        .error_for_status()
        .context("LobeHub SVG tarball download returned HTTP error")?
        .bytes()
        .await
        .context("failed to read LobeHub SVG tarball body")?;

    let lobe_dir = config.lobe_icons_dir.clone();
    let extracted = tokio::task::spawn_blocking(move || extract_svg_tarball(&tgz_bytes, &lobe_dir))
        .await
        .context("tarball extraction task panicked")??;

    // Fill in any built-in fallback SVGs that were absent from the tarball.
    ensure_fallback_icons(&config.lobe_icons_dir)?;
    info!(
        extracted,
        dir = %config.lobe_icons_dir.display(),
        "LobeHub SVG icons synchronized"
    );
    Ok(extracted)
}

/// Extracts `.svg` entries from a gzipped npm `.tgz` archive into `dest_dir`.
fn extract_svg_tarball(tgz_bytes: &[u8], dest_dir: &Path) -> Result<usize> {
    let decoder = GzDecoder::new(tgz_bytes);
    let mut archive = Archive::new(decoder);
    let mut count = 0usize;

    let entries = archive
        .entries()
        .context("failed to iterate LobeHub tarball entries")?;

    for entry_res in entries {
        let mut entry = entry_res.context("failed to read tarball entry")?;
        let path = entry
            .path()
            .context("failed to read tarball entry path")?
            .to_path_buf();

        if !entry.header().entry_type().is_file() {
            continue;
        }
        let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
            continue;
        };
        if !ext.eq_ignore_ascii_case("svg") {
            continue;
        }
        let Some(file_name) = path.file_name() else {
            continue;
        };

        let target_path = dest_dir.join(file_name);
        let mut buf = Vec::new();
        entry
            .read_to_end(&mut buf)
            .with_context(|| format!("failed to read SVG entry {}", path.display()))?;
        fs::write(&target_path, buf)
            .with_context(|| format!("failed to write SVG file {}", target_path.display()))?;
        count = count.saturating_add(1);
    }

    Ok(count)
}

/// Ensures built-in fallback SVG files exist if missing from `lobe_icons_dir`.
///
/// # Errors
/// Returns an error if `lobe_dir` cannot be created.
pub fn ensure_fallback_icons(lobe_dir: &Path) -> Result<()> {
    fs::create_dir_all(lobe_dir)?;
    for (slug, svg) in FALLBACK_SVGS {
        let path = lobe_dir.join(format!("{slug}.svg"));
        if !path.exists()
            && let Err(err) = fs::write(&path, svg)
        {
            warn!(slug, error = %err, "failed to write fallback SVG");
        }
    }
    Ok(())
}

/// Resolves an SVG string for a requested icon name (`slug` or `slug.svg`).
/// Checks `custom_icons_dir`, then `lobe_icons_dir`, then strips `-color`, then built-in fallback.
#[must_use]
pub fn resolve_icon_svg(config: &IconsConfig, raw_name: &str) -> Option<String> {
    let slug = sanitize_icon_slug(raw_name)?;
    let mut candidates = vec![slug.clone()];
    if let Some(base) = slug.strip_suffix("-color") {
        candidates.push(base.to_string());
    }

    for candidate in &candidates {
        if let Some(svg) = read_svg_from_dir(&config.custom_icons_dir, candidate) {
            return Some(svg);
        }
        if let Some(svg) = read_svg_from_dir(&config.lobe_icons_dir, candidate) {
            return Some(svg);
        }
    }

    for candidate in &candidates {
        if let Some((_, svg)) = FALLBACK_SVGS.iter().find(|(name, _)| name == candidate) {
            return Some((*svg).to_string());
        }
    }

    None
}

/// Reads `<dir>/<slug>.svg` if present and valid UTF-8.
fn read_svg_from_dir(dir: &Path, slug: &str) -> Option<String> {
    let file_path: PathBuf = dir.join(format!("{slug}.svg"));
    fs::read_to_string(file_path).ok()
}

/// Validates and normalizes an icon slug to prevent path traversal.
#[must_use]
pub fn sanitize_icon_slug(raw_name: &str) -> Option<String> {
    let stripped = raw_name
        .trim()
        .strip_suffix(".svg")
        .unwrap_or(raw_name.trim());
    if stripped.is_empty()
        || stripped.contains("..")
        || stripped.contains('/')
        || stripped.contains('\\')
    {
        return None;
    }
    if !stripped
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return None;
    }
    Some(stripped.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_sanitization_rejects_traversal() {
        assert_eq!(
            sanitize_icon_slug("deepseek-color.svg"),
            Some("deepseek-color".to_string())
        );
        assert_eq!(sanitize_icon_slug("../secret"), None);
        assert_eq!(sanitize_icon_slug("a/b"), None);
        assert_eq!(sanitize_icon_slug(""), None);
    }

    #[test]
    fn fallback_icon_resolution_works_with_color_strip() {
        let cfg = IconsConfig::default();
        let svg = resolve_icon_svg(&cfg, "deepseek-color.svg");
        assert!(svg.is_some());
        assert!(svg.unwrap_or_default().contains("<svg"));
    }
}
