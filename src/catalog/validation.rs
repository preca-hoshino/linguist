//! Cross-entry structural and script validation shared by catalog writers and loaders.

use std::collections::HashSet;

use anyhow::{Result, ensure};

use super::RuntimeCatalog;
use crate::models::ScriptItem;

/// Validates unique identities and script item invariants across the catalog.
/// Empty catalogs are permitted for clean cold starts.
///
/// # Errors
/// Returns an error if duplicate/blank IDs or invalid script items are found.
pub(super) fn validate(catalog: &RuntimeCatalog) -> Result<()> {
    unique_ids(catalog.providers.iter().map(|p| p.id.as_str()), "provider")?;
    unique_ids(catalog.projects.iter().map(|p| p.id.as_str()), "project")?;
    unique_ids(catalog.routes.iter().map(|r| r.id.as_str()), "route")?;

    for provider in &catalog.providers {
        validate_script_items(&provider.scripts, &format!("provider '{}'", provider.id))?;
        unique_ids(
            provider.models.iter().map(|m| m.id.as_str()),
            "provider model",
        )?;
        for model in &provider.models {
            validate_script_items(
                &model.scripts,
                &format!("model '{}/{}'", provider.id, model.id),
            )?;
        }
    }

    for project in &catalog.projects {
        ensure!(
            !project.api_key.trim().is_empty(),
            "project '{}' must have a non-empty apiKey",
            project.id
        );
        validate_script_items(&project.scripts, &format!("project '{}'", project.id))?;
        unique_ids(
            project.call_models.iter().map(|m| m.id.as_str()),
            "project model",
        )?;
        for cm in &project.call_models {
            ensure!(
                cm.id.trim() != "*",
                "project '{}' callModel id '*' is not allowed",
                project.id
            );
            validate_script_items(
                &cm.scripts,
                &format!("callModel '{}/{}'", project.id, cm.id),
            )?;
        }
    }

    for route in &catalog.routes {
        validate_script_items(&route.scripts, &format!("route '{}'", route.id))?;
    }

    Ok(())
}

/// Ensures script IDs inside an entity's `scripts[]` are non-empty and unique.
pub(crate) fn validate_script_items(scripts: &[ScriptItem], owner: &str) -> Result<()> {
    let mut ids = HashSet::new();
    for item in scripts {
        ensure!(!item.id.trim().is_empty(), "blank script id inside {owner}");
        ensure!(
            ids.insert(item.id.as_str()),
            "duplicate script id '{}' inside {owner}",
            item.id
        );
    }
    Ok(())
}

/// Rejects blank and duplicate IDs within one namespace.
fn unique_ids<'a>(ids: impl Iterator<Item = &'a str>, kind: &str) -> Result<()> {
    let mut unique = HashSet::new();
    for id in ids {
        ensure!(!id.trim().is_empty(), "blank {kind} id");
        ensure!(unique.insert(id), "duplicate {kind} id '{id}'");
    }
    Ok(())
}
