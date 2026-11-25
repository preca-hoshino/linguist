//! PostgreSQL catalog & v0.2.0 administration API integration tests.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;

use arc_swap::ArcSwap;
use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
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
use linguist::catalog::{RuntimeCatalog, sync};
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

    let swap = sync::start(provider.clone(), None).await.unwrap();
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
