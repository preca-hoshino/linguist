//! PostgreSQL catalog integration tests against databases provisioned by `SQLx`.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use arc_swap::ArcSwap;
use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

use linguist::catalog::json_loader::{JsonFileCatalogProvider, write_atomic};
use linguist::catalog::postgres::PgCatalogProvider;
use linguist::catalog::secrets::CatalogSecrets;
use linguist::catalog::{CatalogProvider, RuntimeCatalog, sync};
use linguist::config::{AppConfig, ConfigsSection, ScriptEngineConfig};
use linguist::metrics_cache::MetricsCache;
use linguist::models::CandidateMetrics;
use linguist::script_engine::ScriptEngine;
use linguist::state::AppState;
use linguist::web;

/// Creates three catalog inputs and one external script, isolated from real configuration.
struct Fixture(PathBuf);

impl Fixture {
    /// Writes a directory with duplicate model IDs across providers and tied routing rules.
    fn new() -> Self {
        let fixture =
            Self(std::env::temp_dir().join(format!("linguist-catalog-{}", Uuid::new_v4())));
        std::fs::create_dir(&fixture.0).unwrap();
        fixture.write("providers.json", &providers("Beta", true));
        fixture.write(
            "projects.json",
            &json!([{
                "id": "app", "name": "App", "apiKey": "fixture-project-key",
                "meta": {"region": "test"}, "callModels": [
                    {"id": "client/alias", "name": "Alias", "meta": {"flag": true}},
                    {"id": "other", "name": "Other"}
                ]
            }]),
        );
        fixture.write(
            "routes.json",
            &json!([
                {"id":"disabled","name":"Disabled","enabled":false,"priority":50,
                 "match":{"projectIds":["*"],"callModelIds":["*"]}},
                {"id":"first","name":"First","priority":50,
                 "match":{"projectIds":["app"],"callModelIds":["client/alias"]},
                 "target":{"providerId":"beta","modelId":"vendor/shared","maxAttempts":3},
                 "fallbacks":[{"providerId":"alpha","modelId":"vendor/shared","maxAttempts":2},
                              {"providerId":"beta","modelId":"earlier-in-catalog"}],
                 "script":"@file:route.ts"},
                {"id":"second","name":"Second","priority":50,
                 "match":{"projectIds":["*"],"callModelIds":["*"]},
                 "target":{"providerId":"beta","modelId":"vendor/shared"}}
            ]),
        );
        fixture.write_bytes("route.ts", b"ctx.state.fixture = true;");
        fixture
    }

    /// Resolves an input relative to the fixture root.
    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }

    /// Atomically publishes one changed configuration file.
    fn write(&self, name: &str, json: &Value) {
        self.write_bytes(name, &serde_json::to_vec_pretty(json).unwrap());
    }

    /// Allows tests to publish malformed JSON or a revised external script.
    fn write_bytes(&self, name: &str, bytes: &[u8]) {
        write_atomic(&self.path(name), bytes).unwrap();
    }

    /// Points the catalog loader only at these isolated inputs.
    fn loader(&self, engine: &ScriptEngine) -> JsonFileCatalogProvider {
        JsonFileCatalogProvider::new(
            ConfigsSection {
                providers_path: self.path("providers.json"),
                projects_path: self.path("projects.json"),
                routes_path: self.path("routes.json"),
                ..ConfigsSection::default()
            },
            engine.clone(),
        )
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Builds the supply-side input while varying one provider and its optional unused model.
fn providers(beta_name: &str, unused: bool) -> Value {
    let mut models = vec![
        json!({"id":"vendor/shared","name":"Shared Beta","toolCalling":true,
               "supportsReasoningEffort":["high","low"],
               "url":"https://sample:secret@beta.example/v1?token=unlisted#fragment"}),
        json!({"id":"earlier-in-catalog","name":"Second model","url":"https://beta.example/v1"}),
    ];
    if unused {
        models.push(json!({"id":"unused","name":"Unused","url":"https://beta.example/v1"}));
    }
    json!([
        {"id":"beta","name":beta_name,"vendor":"customendpoint","apiType":"chat-completions",
         "apiKey":"fixture-upstream-key","models":models},
        {"id":"alpha","name":"Alpha","models":[
            {"id":"vendor/shared","name":"Shared Alpha","url":"https://alpha.example/v1"}
        ]}
    ])
}

/// Shares one master key and default script configuration within an isolated test.
fn store(pool: &PgPool) -> (PgCatalogProvider, ScriptEngine) {
    let engine = ScriptEngine::new(ScriptEngineConfig::default());
    let secrets = CatalogSecrets::from_hex(&"ab".repeat(32)).unwrap();
    (
        PgCatalogProvider::new(pool.clone(), secrets, engine.clone()),
        engine,
    )
}

/// Routes in-process requests through the same application as `serve`.
fn app(pool: &PgPool, active: Arc<ArcSwap<RuntimeCatalog>>, engine: ScriptEngine) -> Router {
    let config = AppConfig::default();
    let metrics = MetricsCache::new(&config.metrics);
    web::build_router(
        AppState::new(config, active, metrics, engine, Some(pool.clone()), None)
            .unwrap()
            .with_catalog_token(Some("fixture-console-token")),
    )
}

/// Issues a test HTTP request, consuming the body as JSON when available.
async fn request(
    app: &Router,
    method: Method,
    path: &str,
    token: Option<&str>,
) -> (StatusCode, Value, axum::http::HeaderMap) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header(header::ORIGIN, "https://example.test");
    if let Some(token) = token {
        request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let (parts, body) = response.into_parts();
    let bytes = body.collect().await.unwrap().to_bytes();
    (
        parts.status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        parts.headers,
    )
}

/// Makes an authenticated read of a console endpoint.
async fn catalog(app: &Router, path: &str) -> Value {
    let (status, data, headers) = request(
        app,
        Method::GET,
        &format!("/api/v1/catalog/{path}"),
        Some("fixture-console-token"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{path}: {data}");
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");
    assert!(!headers.contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
    data
}

#[sqlx::test(migrations = "./migrations")]
#[ignore = "requires a disposable PostgreSQL server via DATABASE_URL"]
async fn catalog_projections_and_gateway_use_the_committed_snapshot(pool: PgPool) {
    let fixture = Fixture::new();
    let (store, engine) = store(&pool);
    let active = sync::start(store, Some((fixture.loader(&engine), false)))
        .await
        .unwrap();
    let app = app(&pool, Arc::clone(&active), engine);
    let snapshot = active.load_full();
    assert_eq!(snapshot.revision(), 1);
    let rule = snapshot.match_route_rule("app", "client/alias").unwrap();
    assert_eq!(rule.id, "first");
    let candidates = snapshot.build_candidates(rule, |_, _| CandidateMetrics::default());
    assert_eq!(
        candidates
            .iter()
            .map(|c| (&*c.provider.id, &*c.model.id))
            .collect::<Vec<_>>(),
        [
            ("beta", "vendor/shared"),
            ("beta", "earlier-in-catalog"),
            ("beta", "unused"),
            ("alpha", "vendor/shared")
        ]
    );
    assert_eq!(
        snapshot.find_provider("beta").unwrap().api_key,
        "fixture-upstream-key"
    );
    assert!(snapshot.find_project("app").unwrap().api_key.is_none());
    let (status, data, _) = request(
        &app,
        Method::GET,
        "/model/app/v1/models",
        Some("fixture-project-key"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(data["data"][0]["id"], "client/alias");
    let (status, _, _) = request(
        &app,
        Method::GET,
        "/api/v1/catalog/providers",
        Some("fixture-project-key"),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _, _) = request(
        &app,
        Method::POST,
        "/api/v1/catalog/providers",
        Some("fixture-console-token"),
    )
    .await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);

    let status = catalog(&app, "status").await;
    assert_eq!(status["revision"], 1);
    assert_eq!(status["loadedRevision"], 1);
    assert_eq!(status["writeMode"], "json_sync");

    let page = catalog(&app, "providers?page_size=1").await;
    assert_eq!(page["items"][0]["modelCount"], 3);
    assert_eq!(page["hasNext"], true);
    assert_eq!(
        catalog(&app, "providers?page=2&page_size=1").await["items"][0]["id"],
        "alpha"
    );
    let provider = catalog(&app, "providers/detail?id=beta").await;
    assert_eq!(provider["item"]["hasApiKey"], true);
    assert_eq!(provider["item"]["models"][2]["id"], "unused");
    assert!(!provider.to_string().contains("fixture-upstream-key"));
    let model = catalog(
        &app,
        "provider-models/detail?provider_id=beta&id=vendor%2Fshared",
    )
    .await;
    assert_eq!(model["item"]["name"], "Shared Beta");
    assert_eq!(model["item"]["url"], "https://beta.example/v1");
    assert!(
        catalog(&app, "provider-models?provider_id=alpha").await["items"][0]
            .get("url")
            .is_none()
    );
    assert_eq!(catalog(&app, "projects").await["items"][0]["modelCount"], 2);
    let project = catalog(&app, "projects/detail?id=app").await;
    assert!(!project.to_string().contains("fixture-project-key"));
    assert_eq!(project["item"]["meta"]["region"], "test");
    assert_eq!(
        catalog(&app, "project-models?project_id=app").await["items"][0]["id"],
        "client/alias"
    );
    let routes = catalog(&app, "routes?project_id=app&call_model_id=client%2Falias").await;
    assert_eq!(routes["items"][0]["id"], "disabled");
    assert_eq!(routes["items"][1]["firstMatch"], true);
    assert_eq!(routes["items"][2]["firstMatch"], false);
    assert!(routes["items"][1].get("script").is_none());
    let route = catalog(&app, "routes/detail?id=first").await;
    assert_eq!(route["item"]["target"]["maxAttempts"], 3);
    assert_eq!(route["item"]["fallbacks"][0]["maxAttempts"], 2);
    assert_eq!(
        route["item"]["fallbacks"][1]["modelId"],
        "earlier-in-catalog"
    );
    assert_eq!(route["item"]["script"], "ctx.state.fixture = true;");
}

/// Waits for one of the file watcher or gateway refresh postconditions.
async fn wait_for(mut check: impl AsyncFnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(20), async {
        while !check().await {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("catalog update did not arrive");
}

#[sqlx::test(migrations = "./migrations")]
#[ignore = "requires a disposable PostgreSQL server via DATABASE_URL"]
async fn hot_sync_rolls_back_a_failed_replacement_and_can_be_disabled(pool: PgPool) {
    let fixture = Fixture::new();
    let (store, engine) = store(&pool);
    let loader = fixture.loader(&engine);
    let active = sync::start(store.clone(), Some((loader.clone(), true)))
        .await
        .unwrap();
    let original = active.load_full();
    let mut reader = pool.begin().await.unwrap();
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *reader)
        .await
        .unwrap();
    let revision: i64 = sqlx::query_scalar("SELECT revision FROM catalog_state")
        .fetch_one(&mut *reader)
        .await
        .unwrap();
    assert_eq!(revision, 1);

    // Reject one row during insertion, after deletes, to exercise transactional rollback.
    // The DDL needs an exclusive lock, so add the constraint before opening the old snapshot on these tables.
    sqlx::query(
        "ALTER TABLE catalog_providers ADD CONSTRAINT reject_fixture CHECK (name <> 'Rejected')",
    )
    .execute(&pool)
    .await
    .unwrap();
    fixture.write("providers.json", &providers("Rejected", false));
    wait_for(async || {
        sqlx::query_scalar::<_, bool>("SELECT sync_error IS NOT NULL FROM catalog_state")
            .fetch_one(&pool)
            .await
            .unwrap()
    })
    .await;
    assert_eq!(
        store
            .load_catalog()
            .await
            .unwrap()
            .find_provider("beta")
            .unwrap()
            .name,
        "Beta"
    );
    fixture.write("providers.json", &providers("Renamed", false));
    wait_for(async || active.load().revision() == 2).await;
    let next = active.load_full();
    assert_eq!(original.find_provider("beta").unwrap().name, "Beta");
    assert_eq!(next.find_provider("beta").unwrap().name, "Renamed");
    assert!(next.find_model("beta", "unused").is_none());
    let old: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM catalog_provider_models WHERE id = 'unused'")
            .fetch_one(&mut *reader)
            .await
            .unwrap();
    assert_eq!(old, 1);
    reader.commit().await.unwrap();

    fixture.write_bytes("route.ts", b"ctx.state.fixture = false;");
    wait_for(async || active.load().revision() == 3).await;
    assert_eq!(
        active.load().routes[1].script.as_deref(),
        Some("ctx.state.fixture = false;")
    );
    fixture.write_bytes("providers.json", b"[broken");
    wait_for(async || {
        sqlx::query_scalar::<_, bool>("SELECT sync_error IS NOT NULL FROM catalog_state")
            .fetch_one(&pool)
            .await
            .unwrap()
    })
    .await;
    assert_eq!(active.load().revision(), 3);
    fixture.write("providers.json", &providers("Renamed", false));
    wait_for(async || {
        sqlx::query_scalar::<_, bool>("SELECT sync_error IS NULL FROM catalog_state")
            .fetch_one(&pool)
            .await
            .unwrap()
    })
    .await;
    assert_eq!(store.load_catalog().await.unwrap().revision(), 3);

    store.disable_json_sync().await.unwrap();
    fixture.write("providers.json", &providers("Must not write", true));
    let restarted = sync::start(store.clone(), Some((loader, false)))
        .await
        .unwrap();
    assert_eq!(restarted.load().revision(), 3);
    std::fs::remove_file(fixture.path("providers.json")).unwrap();
    let postgres_only = sync::start(store, None).await.unwrap();
    assert_eq!(postgres_only.load().revision(), 3);
}
