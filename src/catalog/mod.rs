//! Configuration catalog snapshot (`RuntimeCatalog`) and `CatalogProvider` abstraction.

pub mod json_loader;

use std::collections::HashMap;

use anyhow::Result;
use async_trait::async_trait;
use serde_json::{Value, json};

use crate::models::{
    CallModelConfig, CandidateItem, CandidateMetrics, ModelConfig, ProjectConfig, ProviderConfig,
    RouteCandidatesFilter, RouteRuleConfig,
};

/// Abstract catalog source trait decoupling runtime routing from storage backends
/// (`JsonFileCatalogProvider` now; `PgCatalogProvider` in future).
#[async_trait]
pub trait CatalogProvider: Send + Sync {
    /// Loads and validates a complete `RuntimeCatalog` snapshot.
    async fn load_catalog(&self) -> Result<RuntimeCatalog>;
}

/// Immutable in-memory snapshot of supply providers/models, consume projects/callModels,
/// and routing rules stored inside `ArcSwap<RuntimeCatalog>`.
#[derive(Debug, Clone, Default)]
pub struct RuntimeCatalog {
    /// Supply-side providers and models.
    pub providers: Vec<ProviderConfig>,
    /// Lookup index `provider_id -> index in providers`.
    provider_by_id: HashMap<String, usize>,
    /// Consume-side projects and call models.
    pub projects: Vec<ProjectConfig>,
    /// Lookup index `project_id -> index in projects`.
    project_by_id: HashMap<String, usize>,
    /// Routing rules sorted descending by `priority`.
    pub routes: Vec<RouteRuleConfig>,
}

impl RuntimeCatalog {
    /// Constructs a new `RuntimeCatalog` and indexes providers, projects, and sorted routes.
    #[must_use]
    pub fn new(
        providers: Vec<ProviderConfig>,
        projects: Vec<ProjectConfig>,
        mut routes: Vec<RouteRuleConfig>,
    ) -> Self {
        let mut provider_by_id = HashMap::with_capacity(providers.len());
        for (idx, p) in providers.iter().enumerate() {
            provider_by_id.insert(p.id.clone(), idx);
        }

        let mut project_by_id = HashMap::with_capacity(projects.len());
        for (idx, p) in projects.iter().enumerate() {
            project_by_id.insert(p.id.clone(), idx);
        }

        routes.sort_by_key(|a| std::cmp::Reverse(a.priority));

        Self {
            providers,
            provider_by_id,
            projects,
            project_by_id,
            routes,
        }
    }

    /// Looks up a provider by ID.
    #[must_use]
    pub fn find_provider(&self, provider_id: &str) -> Option<&ProviderConfig> {
        self.provider_by_id
            .get(provider_id)
            .and_then(|&idx| self.providers.get(idx))
    }

    /// Looks up a `(provider, model)` pair by IDs.
    #[must_use]
    pub fn find_model(
        &self,
        provider_id: &str,
        model_id: &str,
    ) -> Option<(&ProviderConfig, &ModelConfig)> {
        let provider = self.find_provider(provider_id)?;
        let model = provider.models.iter().find(|m| m.id == model_id)?;
        Some((provider, model))
    }

    /// Looks up a project by ID.
    #[must_use]
    pub fn find_project(&self, project_id: &str) -> Option<&ProjectConfig> {
        self.project_by_id
            .get(project_id)
            .and_then(|&idx| self.projects.get(idx))
    }

    /// Resolves `(project, callModel)` by exact match of the requested model against the
    /// project's declared `callModels` (there is no wildcard fallback).
    #[must_use]
    pub fn resolve_project_and_call_model(
        &self,
        project_id: &str,
        requested_model: &str,
    ) -> Option<(&ProjectConfig, &CallModelConfig)> {
        let project = self.find_project(project_id)?;
        project
            .call_models
            .iter()
            .find(|cm| cm.id == requested_model)
            .map(|cm| (project, cm))
    }

    /// Finds the highest-priority enabled route rule matching `(project_id, call_model_id)`.
    #[must_use]
    pub fn match_route_rule(
        &self,
        project_id: &str,
        call_model_id: &str,
    ) -> Option<&RouteRuleConfig> {
        self.routes.iter().find(|rule| {
            rule.enabled
                && list_matches(&rule.match_rule.project_ids, project_id)
                && list_matches(&rule.match_rule.call_model_ids, call_model_id)
        })
    }

    /// Expands all eligible `(provider, model)` candidates for `rule` and enriches each
    /// with live sliding-window metrics via `metrics_lookup`.
    pub fn build_candidates<F>(
        &self,
        rule: &RouteRuleConfig,
        metrics_lookup: F,
    ) -> Vec<CandidateItem>
    where
        F: Fn(&str, &str) -> CandidateMetrics,
    {
        let mut out = Vec::new();
        for provider in &self.providers {
            for model in &provider.models {
                if candidate_allowed(&rule.candidates, &provider.id, &model.id) {
                    out.push(CandidateItem {
                        provider: provider.to_meta(),
                        model: model.to_meta(),
                        metrics: metrics_lookup(&provider.id, &model.id),
                    });
                }
            }
        }
        out
    }

    /// Builds the OpenAI-compatible model list for `/model/{project_id}/v1/models`:
    /// exactly the project's declared `callModels`. Unknown projects yield an empty list.
    #[must_use]
    pub fn list_openai_models(&self, project_id: &str) -> Vec<Value> {
        let Some(project) = self.find_project(project_id) else {
            return Vec::new();
        };
        project
            .call_models
            .iter()
            .map(|cm| {
                json!({
                    "id": cm.id,
                    "object": "model",
                    "owned_by": project.id,
                    "display_name": cm.name
                })
            })
            .collect()
    }
    /// Total count of configured models across all supply providers.
    #[must_use]
    pub fn total_models(&self) -> usize {
        self.providers.iter().map(|p| p.models.len()).sum()
    }
}

/// Checks if `patterns` contains `"*"` or an exact match for `value`.
fn list_matches(patterns: &[String], value: &str) -> bool {
    patterns.iter().any(|p| p == "*" || p == value)
}

/// Evaluates `allow` and `deny` candidate filter rules for `(provider_id, model_id)`.
fn candidate_allowed(filter: &RouteCandidatesFilter, provider_id: &str, model_id: &str) -> bool {
    let allowed = if filter.allow.is_empty() {
        true
    } else {
        filter
            .allow
            .iter()
            .any(|pat| pattern_matches(pat, provider_id, model_id))
    };
    if !allowed {
        return false;
    }
    !filter
        .deny
        .iter()
        .any(|pat| pattern_matches(pat, provider_id, model_id))
}

/// Matches patterns of the form `"*"`, `"provider/*"`, `"provider/model"`, or `"model"`.
fn pattern_matches(pattern: &str, provider_id: &str, model_id: &str) -> bool {
    let pat = pattern.trim();
    if pat == "*" {
        return true;
    }
    if let Some((p_pat, m_pat)) = pat.split_once('/') {
        let p_ok = p_pat == "*" || p_pat == provider_id;
        let m_ok = m_pat == "*" || m_pat == model_id;
        p_ok && m_ok
    } else {
        pat == model_id || pat == provider_id
    }
}
