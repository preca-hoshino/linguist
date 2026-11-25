//! PostgreSQL catalog & v0.2.0 administration API integration tests.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;

use arc_swap::ArcSwap;
use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

use linguist::auth::oidc::OidcClient;
use linguist::catalog::postgres::PgCatalogProvider;
use linguist::catalog::postgres::write::{
    ProjectModelWriteInput, ProjectWriteInput, ProviderModelWriteInput, ProviderWriteInput,
    RouteWriteInput,
};
use linguist::catalog::read::Resource;
use linguist::catalog::secrets::CatalogSecrets;
use linguist::catalog::{CatalogProvider, RuntimeCatalog, migrate_v02, sync};
use linguist::config::{AppConfig, MetricsConfig, ScriptEngineConfig, ValidatedOidcConfig};
use linguist::metrics_cache::MetricsCache;
use linguist::models::{
    CallModelConfig, CompiledScriptChain, ModelConfig, ProjectConfig, ProviderConfig,
    RouteRuleConfig, ScriptItem,
};
use linguist::script_engine::ScriptEngine;
use linguist::state::AppState;
use linguist::web;

fn test_secrets() -> CatalogSecrets {
    CatalogSecrets::from_hex("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
        .unwrap()
}

fn dummy_oidc() -> OidcClient {
    OidcClient::new(ValidatedOidcConfig {
        issuer: "https://idp.example.test/oidc".into(),
        client_id: "linguist-test".into(),
        client_secret: "secret".into(),
        redirect_uri: "https://linguist.example.test/auth/callback".into(),
        admin_sub: "admin-sub".into(),
        secure_cookies: false,
    })
    .unwrap()
}

fn compile_single(
    engine: &ScriptEngine,
    id: &str,
    code: &str,
) -> (Vec<ScriptItem>, linguist::models::CompiledScriptChain) {
    let items = vec![ScriptItem {
        id: id.to_string(),
        name: id.to_string(),
        enabled: true,
        code: code.to_string(),
    }];
    let compiled = engine.compile_chain(&items).unwrap();
    (items, compiled)
}

#[tokio::test]
async fn catalog_endpoints_require_auth_and_db() {
    let engine = ScriptEngine::new(ScriptEngineConfig::default());
    let (m_scripts, m_compiled) = compile_single(
        &engine,
        "m",
        "export const meta = { url: 'https://api.openai.com/v1/chat/completions' };",
    );
    let (r_scripts, r_compiled) = compile_single(
        &engine,
        "r",
        "export function onRequest(ctx) { ctx.route.target = { providerId: 'openai', modelId: 'gpt-4o' }; return ctx; }",
    );
    let catalog = RuntimeCatalog::new(
        vec![ProviderConfig {
            id: "openai".to_string(),
            name: "OpenAI".to_string(),
            icon: "openai".to_string(),
            enabled: true,
            api_key: "sk-test".to_string(),
            scripts: vec![],
            compiled: CompiledScriptChain::default(),
            models: vec![ModelConfig {
                id: "gpt-4o".to_string(),
                name: "GPT-4o".to_string(),
                icon: "openai".to_string(),
                enabled: true,
                scripts: m_scripts,
                compiled: m_compiled,
            }],
        }],
        vec![ProjectConfig {
            id: "app".to_string(),
            name: "App".to_string(),
            icon: "openai".to_string(),
            enabled: true,
            api_key: "proj-key".to_string(),
            scripts: vec![],
            compiled: CompiledScriptChain::default(),
            call_models: vec![CallModelConfig {
                id: "smart".to_string(),
                name: "Smart".to_string(),
                icon: "openai".to_string(),
                enabled: true,
                scripts: vec![],
                compiled: CompiledScriptChain::default(),
            }],
        }],
        vec![RouteRuleConfig {
            id: "r1".to_string(),
            name: "R1".to_string(),
            icon: "route".to_string(),
            enabled: true,
            position: 1,
            scripts: r_scripts,
            compiled: r_compiled,
        }],
    );

    let state = AppState::new(
        AppConfig::default(),
        Arc::new(ArcSwap::from_pointee(catalog)),
        MetricsCache::new(&MetricsConfig::default()),
        engine,
        None,
        None,
    )
    .unwrap()
    .with_oidc(dummy_oidc());

    let app: Router = web::build_router(state);
    for (method, path) in [
        (Method::GET, "/api/v1/catalog/providers"),
        (Method::POST, "/api/v1/catalog/scripts/validate"),
        (Method::POST, "/api/v1/catalog/dry-run"),
    ] {
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE, "{path}");
    }
}

#[sqlx::test(migrations = "./migrations")]
#[ignore = "requires a disposable PostgreSQL server via DATABASE_URL"]
async fn pg_catalog_crud_reorder_and_runtime_reload(pool: PgPool) {
    let engine = ScriptEngine::new(ScriptEngineConfig::default());
    let provider = PgCatalogProvider::new(pool.clone(), test_secrets(), engine.clone());

    let rev1 = provider
        .create_provider(ProviderWriteInput {
            id: "p1".into(),
            name: "Provider One".into(),
            icon: String::new(),
            enabled: true,
            api_key: Some("sk-p1".into()),
            clear_api_key: false,
            scripts: vec![],
            expected_revision: None,
        })
        .await
        .unwrap();
    assert!(rev1 >= 1);

    let rev2 = provider
        .create_provider_model(ProviderModelWriteInput {
            provider_id: "p1".into(),
            id: "m1".into(),
            name: "Model One".into(),
            icon: String::new(),
            enabled: true,
            scripts: vec![ScriptItem {
                id: "url".into(),
                name: "URL".into(),
                enabled: true,
                code: "export const meta = { url: 'https://example.test/v1' };".into(),
            }],
            expected_revision: Some(rev1),
        })
        .await
        .unwrap();

    // Stale expected_revision must fail with revision_conflict.
    let conflict = provider
        .create_project(ProjectWriteInput {
            id: "proj".into(),
            name: "Proj".into(),
            icon: String::new(),
            enabled: true,
            api_key: "plain-key".into(),
            scripts: vec![],
            expected_revision: Some(rev1),
        })
        .await
        .unwrap_err();
    assert!(conflict.to_string().contains("revision_conflict"));

    let rev3 = provider
        .create_project(ProjectWriteInput {
            id: "proj".into(),
            name: "Proj".into(),
            icon: String::new(),
            enabled: true,
            api_key: "plain-key".into(),
            scripts: vec![],
            expected_revision: Some(rev2),
        })
        .await
        .unwrap();

    let rev4 = provider
        .create_project_model(ProjectModelWriteInput {
            project_id: "proj".into(),
            id: "cm1".into(),
            name: "CM1".into(),
            icon: String::new(),
            enabled: true,
            scripts: vec![],
            expected_revision: Some(rev3),
        })
        .await
        .unwrap();

    let _rev5 = provider
        .create_route(RouteWriteInput {
            id: "r1".into(),
            name: "Route 1".into(),
            icon: String::new(),
            enabled: true,
            scripts: vec![ScriptItem {
                id: "route".into(),
                name: "Route".into(),
                enabled: true,
                code: "export function onRequest(ctx) { ctx.route.target = { providerId: 'p1', modelId: 'm1' }; return ctx; }".into(),
            }],
            expected_revision: Some(rev4),
        })
        .await
        .unwrap();

    let _rev6 = provider
        .create_route(RouteWriteInput {
            id: "r2".into(),
            name: "Route 2".into(),
            icon: String::new(),
            enabled: true,
            scripts: vec![],
            expected_revision: None,
        })
        .await
        .unwrap();

    provider
        .reorder_resource(Resource::Routes, None, &["r2".into(), "r1".into()], None)
        .await
        .unwrap();

    let swap = sync::start(provider.clone()).await.unwrap();
    let loaded = swap.load();
    assert_eq!(loaded.routes.len(), 2);
    assert_eq!(loaded.routes[0].id, "r2");
    assert_eq!(loaded.routes[1].id, "r1");
    assert_eq!(loaded.projects[0].api_key, "plain-key");

    // Deleting provider with children must fail.
    let err = provider
        .delete_resource(Resource::Providers, "p1", None, None)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("has_children"));

    provider
        .delete_resource(Resource::ProviderModels, "m1", Some("p1"), None)
        .await
        .unwrap();
    provider
        .delete_resource(Resource::Providers, "p1", None, None)
        .await
        .unwrap();

    let reloaded = sync::reload_now(&provider, &swap).await.unwrap();
    assert!(reloaded > 0);
    assert!(swap.load().providers.is_empty());
}

#[sqlx::test(migrations = "./migrations")]
#[ignore = "requires a disposable PostgreSQL server via DATABASE_URL"]
async fn migrate_v02_transforms_v010_tables_atomically(pool: PgPool) {
    // Recreate a minimal v0.1.0 schema state to test `run_migrate_v02` end-to-end.
    sqlx::raw_sql(
        r"
        DROP TABLE IF EXISTS catalog_route_targets, catalog_route_rules, catalog_project_models, catalog_projects, catalog_provider_models, catalog_providers CASCADE;
        CREATE TABLE catalog_providers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            icon TEXT NOT NULL DEFAULT '',
            vendor TEXT,
            api_type TEXT,
            encrypted_key BYTEA,
            script TEXT,
            position BIGINT NOT NULL UNIQUE
        );
        CREATE TABLE catalog_provider_models (
            provider_id TEXT NOT NULL REFERENCES catalog_providers(id) ON DELETE CASCADE,
            id TEXT NOT NULL,
            name TEXT NOT NULL,
            icon TEXT NOT NULL DEFAULT '',
            url TEXT NOT NULL,
            supports_reasoning_effort TEXT[],
            tool_calling BOOLEAN,
            vision BOOLEAN,
            thinking BOOLEAN,
            streaming BOOLEAN,
            max_input_tokens BIGINT,
            max_output_tokens BIGINT,
            script TEXT,
            position BIGINT NOT NULL,
            PRIMARY KEY (provider_id, id),
            UNIQUE (provider_id, position)
        );
        CREATE TABLE catalog_projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            icon TEXT NOT NULL DEFAULT '',
            key_digest BYTEA NOT NULL,
            meta JSONB NOT NULL DEFAULT '{}'::jsonb,
            script TEXT,
            position BIGINT NOT NULL UNIQUE
        );
        CREATE TABLE catalog_project_models (
            project_id TEXT NOT NULL REFERENCES catalog_projects(id) ON DELETE CASCADE,
            id TEXT NOT NULL,
            name TEXT NOT NULL,
            icon TEXT NOT NULL DEFAULT '',
            meta JSONB NOT NULL DEFAULT '{}'::jsonb,
            script TEXT,
            position BIGINT NOT NULL,
            PRIMARY KEY (project_id, id),
            UNIQUE (project_id, position)
        );
        CREATE TABLE catalog_route_rules (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            priority INTEGER NOT NULL DEFAULT 0,
            project_ids TEXT[] NOT NULL DEFAULT ARRAY['*']::text[],
            call_model_ids TEXT[] NOT NULL DEFAULT ARRAY['*']::text[],
            allow_patterns TEXT[] NOT NULL DEFAULT '{}'::text[],
            deny_patterns TEXT[] NOT NULL DEFAULT '{}'::text[],
            rewrite_response_model BOOLEAN NOT NULL DEFAULT TRUE,
            script TEXT,
            position BIGINT NOT NULL UNIQUE
        );
        CREATE TABLE catalog_route_targets (
            route_id TEXT NOT NULL REFERENCES catalog_route_rules(id) ON DELETE CASCADE,
            position BIGINT NOT NULL,
            provider_id TEXT NOT NULL,
            model_id TEXT NOT NULL,
            max_attempts SMALLINT NOT NULL DEFAULT 1,
            PRIMARY KEY (route_id, position)
        );
        ALTER TABLE catalog_state DROP COLUMN IF EXISTS schema_version;
        ALTER TABLE catalog_state ADD COLUMN IF NOT EXISTS billing_prices JSONB NOT NULL DEFAULT '[]'::jsonb;
        ",
    )
    .execute(&pool)
    .await
    .unwrap();

    let secrets = test_secrets();
    let app_digest = secrets.digest_project("app", "migrated-plain-key");

    sqlx::query("INSERT INTO catalog_providers (id, name, icon, position) VALUES ('prov', 'Prov', 'openai', 1)")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO catalog_provider_models (provider_id, id, name, icon, url, position) VALUES ('prov', 'm1', 'M1', 'openai', 'https://mock.test/v1', 1)")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO catalog_projects (id, name, icon, key_digest, position) VALUES ('app', 'App', 'openai', $1, 1)")
        .bind(app_digest.as_slice())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO catalog_project_models (project_id, id, name, icon, position) VALUES ('app', 'cm1', 'CM1', 'openai', 1)")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO catalog_route_rules (id, name, enabled, priority, project_ids, call_model_ids, position) VALUES ('r1', 'R1', true, 100, ARRAY['app'], ARRAY['cm1'], 1)",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO catalog_route_targets (route_id, position, provider_id, model_id, max_attempts) VALUES ('r1', 0, 'prov', 'm1', 2)",
    )
    .execute(&pool)
    .await
    .unwrap();

    let dir = std::env::temp_dir().join(format!("linguist-v02-mig-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let proj_json = dir.join("projects.json");
    std::fs::write(
        &proj_json,
        serde_json::to_vec(&json!([{ "id": "app", "apiKey": "migrated-plain-key" }])).unwrap(),
    )
    .unwrap();

    let engine = ScriptEngine::new(ScriptEngineConfig::default());
    let report = migrate_v02::run_migrate_v02(&pool, &test_secrets(), &engine, Some(&proj_json))
        .await
        .unwrap();
    let _ = std::fs::remove_dir_all(&dir);

    assert_eq!(report.providers, 1);
    assert_eq!(report.provider_models, 1);
    assert_eq!(report.projects, 1);
    assert_eq!(report.project_models, 1);
    assert_eq!(report.routes, 1);

    let loaded = PgCatalogProvider::new(pool, test_secrets(), engine)
        .load_catalog()
        .await
        .unwrap();
    assert_eq!(loaded.projects[0].api_key, "migrated-plain-key");
    assert_eq!(
        loaded.providers[0].models[0]
            .compiled
            .meta
            .get("url")
            .and_then(Value::as_str),
        Some("https://mock.test/v1")
    );
}
