//! Official `LobeHub` SVG icons embedded in the application binary.

use crate::web::embedded_assets::LobeIcons;

/// Resolves an embedded SVG by slug, falling back to its monochrome icon when available.
#[must_use]
pub fn resolve_icon_svg(raw_name: &str) -> Option<Vec<u8>> {
    let slug = sanitize_icon_slug(raw_name)?;
    let icon = LobeIcons::get(&format!("{slug}.svg")).or_else(|| {
        slug.strip_suffix("-color")
            .and_then(|base| LobeIcons::get(&format!("{base}.svg")))
    })?;
    Some(icon.data.into_owned())
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
    fn bundled_svg_resolution_handles_common_icons_and_unknown_slugs() {
        for slug in ["deepseek-color", "doubao-color", "lobehub"] {
            let svg = resolve_icon_svg(&format!("{slug}.svg"));
            assert!(
                svg.is_some_and(|bytes| bytes.starts_with(b"<svg")),
                "{slug}"
            );
        }
        assert!(resolve_icon_svg("unknown-model-icon").is_none());
    }

    #[test]
    fn every_bundled_icon_is_a_valid_embedded_svg() {
        let icon_names: Vec<String> = LobeIcons::iter().collect();
        assert_eq!(icon_names.len(), 997);

        for icon_name in icon_names {
            assert!(icon_name.ends_with(".svg"), "unexpected asset: {icon_name}");
            assert!(
                LobeIcons::get(&icon_name)
                    .is_some_and(|icon| icon.data.starts_with(b"<svg")),
                "icon is missing or invalid in the embedded asset pack: {icon_name}"
            );
        }
    }

    #[test]
    fn missing_color_icon_falls_back_to_its_bundled_monochrome_icon() {
        assert_eq!(
            resolve_icon_svg("xiaomimimo-color.svg"),
            resolve_icon_svg("xiaomimimo.svg")
        );
    }
}
