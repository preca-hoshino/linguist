//! Configuration catalog snapshot (`RuntimeCatalog`) and `CatalogProvider` abstraction.

pub mod migrate_v02;
pub mod postgres;
pub mod read;
pub mod secrets;
pub mod sync;
pub mod validation;

use std::collections::{BTreeSet, HashMap};

use anyhow::Result;
use async_trait::async_trait;
use serde_json::{Value, json};

use crate::catalog::secrets::tokens_equal;
use crate::models::{
    CallModelConfig, CandidateItem, CandidateMetrics, ModelConfig, ProjectConfig, ProviderConfig,
    RouteRuleConfig,
};

/// Loads a complete runtime snapshot, independent of the storage backend.
#[async_trait]
pub trait CatalogProvider: Send + Sync {
    /// Loads and validates a complete `RuntimeCatalog` snapshot.
    async fn load_catalog(&self) -> Result<RuntimeCatalog>;
}

/// Immutable in-memory snapshot of supply providers/models, consume projects/callModels,
/// and ordered routing rules stored inside `ArcSwap<RuntimeCatalog>`.
#[derive(Debug, Clone, Default)]
pub struct RuntimeCatalog {
    /// Supply-side providers and models ordered by `position`.
    pub providers: Vec<ProviderConfig>,
    /// Lookup index `provider_id -> index in providers`.
    provider_by_id: HashMap<String, usize>,
    /// Consume-side projects and call models ordered by `position`.
    pub projects: Vec<ProjectConfig>,
    /// Lookup index `project_id -> index in projects`.
    project_by_id: HashMap<String, usize>,
    /// Routing rules ordered ascending by `position`.
    pub routes: Vec<RouteRuleConfig>,
    /// Committed PostgreSQL revision; zero for an empty cold-start or test snapshot.
    revision: i64,
}

impl RuntimeCatalog {
    /// Constructs a new `RuntimeCatalog` and indexes providers, projects, and ordered routes.
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

        routes.sort_by_key(|r| r.position);

        Self {
            providers,
            provider_by_id,
            projects,
            project_by_id,
            routes,
            revision: 0,
        }
    }

    /// Returns the loaded PostgreSQL revision (zero for an empty/uncommitted snapshot).
    #[must_use]
    pub const fn revision(&self) -> i64 {
        self.revision
    }

    /// Attaches the committed PostgreSQL revision to this snapshot.
    #[must_use]
    pub const fn with_revision(mut self, revision: i64) -> Self {
        self.revision = revision;
        self
    }

    /// Verifies a project bearer credential against this snapshot in constant time.
    #[must_use]
    pub fn verify_project_key(&self, project_id: &str, token: &str) -> bool {
        self.find_project(project_id)
            .filter(|project| project.enabled && !project.api_key.trim().is_empty())
            .is_some_and(|project| tokens_equal(project.api_key.as_bytes(), token.as_bytes()))
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

    /// Resolves an enabled `(project, callModel)` by exact ID match.
    #[must_use]
    pub fn resolve_project_and_call_model(
        &self,
        project_id: &str,
        requested_model: &str,
    ) -> Option<(&ProjectConfig, &CallModelConfig)> {
        let project = self.find_project(project_id).filter(|p| p.enabled)?;
        project
            .call_models
            .iter()
            .find(|cm| cm.enabled && cm.id == requested_model)
            .map(|cm| (project, cm))
    }

    /// Builds the full enabled `(provider, model)` candidate pool enriched with live metrics.
    pub fn build_all_candidates<F>(&self, metrics_lookup: F) -> Vec<CandidateItem>
    where
        F: Fn(&str, &str) -> CandidateMetrics,
    {
        let mut out = Vec::new();
        for provider in &self.providers {
            if !provider.enabled {
                continue;
            }
            for model in &provider.models {
                if !model.enabled {
                    continue;
                }
                out.push(CandidateItem {
                    provider: provider.to_entity_info(),
                    model: model.to_entity_info(),
                    metrics: metrics_lookup(&provider.id, &model.id),
                });
            }
        }
        out
    }

    /// Builds the OpenAI-compatible model list for `/model/{project_id}/v1/models`:
    /// all enabled `callModels` declared under the project.
    #[must_use]
    pub fn list_openai_models(&self, project_id: &str) -> Vec<Value> {
        let Some(project) = self.find_project(project_id).filter(|p| p.enabled) else {
            return Vec::new();
        };
        project
            .call_models
            .iter()
            .filter(|cm| cm.enabled)
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

    /// Extracts distinct 3-letter currency codes declared in provider/model `meta` for FX warmup.
    #[must_use]
    pub fn declared_currencies(&self) -> BTreeSet<String> {
        let mut out = BTreeSet::new();
        for p in &self.providers {
            collect_currency_from_meta(&p.compiled.meta, &mut out);
            for m in &p.models {
                collect_currency_from_meta(&m.compiled.meta, &mut out);
            }
        }
        out
    }
}

/// Inspects `meta.currency` and `meta.pricing.currency` for 3-letter ISO currency codes.
fn collect_currency_from_meta(meta: &serde_json::Map<String, Value>, out: &mut BTreeSet<String>) {
    let candidates = [
        meta.get("currency").and_then(Value::as_str),
        meta.get("pricing")
            .and_then(|p| p.get("currency"))
            .and_then(Value::as_str),
    ];
    for c in candidates.into_iter().flatten() {
        let upper = c.trim().to_ascii_uppercase();
        if upper.len() == 3 && upper.bytes().all(|b| b.is_ascii_uppercase()) {
            out.insert(upper);
        }
    }
}
