//! Cross-entry checks shared by catalog writers and runtime readers.

use std::collections::HashSet;

use anyhow::{Context, Result, ensure};

use super::RuntimeCatalog;
use crate::script_engine::ScriptEngine;

/// Revalidates all script stages when a stored revision is loaded.
pub(super) fn validate_scripts(catalog: &RuntimeCatalog, engine: &ScriptEngine) -> Result<()> {
    let providers = catalog.providers.iter().flat_map(|provider| {
        std::iter::once((provider.id.as_str(), provider.script.as_deref())).chain(
            provider
                .models
                .iter()
                .map(|model| (model.id.as_str(), model.script.as_deref())),
        )
    });
    let projects = catalog.projects.iter().flat_map(|project| {
        std::iter::once((project.id.as_str(), project.script.as_deref())).chain(
            project
                .call_models
                .iter()
                .map(|model| (model.id.as_str(), model.script.as_deref())),
        )
    });
    let routes = catalog
        .routes
        .iter()
        .map(|route| (route.id.as_str(), route.script.as_deref()));
    for (id, source) in providers.chain(projects).chain(routes) {
        if let Some(source) = source {
            engine
                .validate_script(source)
                .with_context(|| format!("invalid catalog script for '{id}'"))?;
        }
    }
    Ok(())
}

/// Checks identities and static route references before the catalog can take effect.
pub(super) fn validate(catalog: &RuntimeCatalog) -> Result<()> {
    ensure!(
        !(catalog.providers.is_empty() && catalog.projects.is_empty() && catalog.routes.is_empty()),
        "the configuration catalog is empty"
    );
    unique_ids(catalog.providers.iter().map(|p| p.id.as_str()), "provider")?;
    unique_ids(catalog.projects.iter().map(|p| p.id.as_str()), "project")?;
    unique_ids(catalog.routes.iter().map(|r| r.id.as_str()), "route")?;
    let mut endpoints = HashSet::new();
    for provider in &catalog.providers {
        unique_ids(
            provider.models.iter().map(|m| m.id.as_str()),
            "provider model",
        )?;
        for model in &provider.models {
            ensure!(
                [model.max_input_tokens, model.max_output_tokens]
                    .into_iter()
                    .flatten()
                    .all(|n| i64::try_from(n).is_ok()),
                "token limit exceeds PostgreSQL range for '{}/{}'",
                provider.id,
                model.id
            );
            endpoints.insert((provider.id.as_str(), model.id.as_str()));
        }
    }
    for project in &catalog.projects {
        unique_ids(
            project.call_models.iter().map(|m| m.id.as_str()),
            "project model",
        )?;
    }
    for route in &catalog.routes {
        for endpoint in route.target.iter().chain(&route.fallbacks) {
            ensure!(
                endpoints.contains(&(endpoint.provider_id.as_str(), endpoint.model_id.as_str())),
                "route '{}' references unknown model '{}/{}'",
                route.id,
                endpoint.provider_id,
                endpoint.model_id
            );
        }
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
