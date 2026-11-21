//! Built-in fallback `LobeHub` SVG icon assets served read-only from memory.

/// Core fallback SVG icons served read-only from memory when `/icons/{slug}.svg` is requested.
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

/// Resolves a built-in SVG string for a requested icon name (`slug` or `slug.svg`).
/// Tries exact slug first, then strips `-color`.
#[must_use]
pub fn resolve_icon_svg(raw_name: &str) -> Option<&'static str> {
    let slug = sanitize_icon_slug(raw_name)?;
    let mut candidates = vec![slug.clone()];
    if let Some(base) = slug.strip_suffix("-color") {
        candidates.push(base.to_string());
    }

    for candidate in &candidates {
        if let Some((_, svg)) = FALLBACK_SVGS.iter().find(|(name, _)| name == candidate) {
            return Some(*svg);
        }
    }

    None
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
    fn fallback_icon_resolution_works_from_memory() {
        let svg = resolve_icon_svg("deepseek-color.svg");
        assert!(svg.is_some());
        assert!(svg.unwrap_or_default().contains("<svg"));
        assert!(resolve_icon_svg("unknown-model-icon").is_none());
    }
}
