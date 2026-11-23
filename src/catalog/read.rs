//! Explicit read-only projections of the active configuration tables.

use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Transaction};

use super::postgres::begin_read;

/// Configuration resources exposed by the console.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Resource {
    /// Upstream providers.
    Providers,
    /// Models under providers.
    ProviderModels,
    /// Client projects.
    Projects,
    /// Models exposed to a project's clients.
    ProjectModels,
    /// Routing rules in evaluation order.
    Routes,
}

/// Validated filters shared by list and detail queries.
#[derive(Debug, Default)]
pub(crate) struct Filters<'a> {
    /// Exact entity ID for detail queries.
    pub(crate) id: Option<&'a str>,
    /// ID or display-name substring.
    pub(crate) search: Option<&'a str>,
    /// Provider filter on the upstream model list.
    pub(crate) provider: Option<&'a str>,
    /// Owning project or routing match filter.
    pub(crate) project: Option<&'a str>,
    /// Project model for the routing match filter.
    pub(crate) call_model: Option<&'a str>,
    /// Maximum number of rows, including the next-page probe.
    pub(crate) limit: i64,
    /// Number of preceding list rows.
    pub(crate) offset: i64,
}

/// Reads one revision and its requested rows as a consistent snapshot.
pub(crate) async fn fetch(
    pool: &PgPool,
    resource: Resource,
    filters: &Filters<'_>,
) -> Result<(i64, Vec<Value>), sqlx::Error> {
    let mut tx = begin_read(pool).await?;
    let revision = sqlx::query_scalar("SELECT revision FROM catalog_state WHERE singleton")
        .fetch_one(&mut *tx)
        .await?;
    let mut items = match resource {
        Resource::Providers | Resource::Projects => {
            fetch_parents(&mut tx, resource, filters).await?
        }
        Resource::ProviderModels | Resource::ProjectModels => {
            fetch_models(&mut tx, resource, filters).await?
        }
        Resource::Routes => fetch_routes(&mut tx, filters).await?,
    };
    tx.commit().await?;
    if matches!(resource, Resource::ProviderModels) && filters.id.is_some() {
        for item in &mut items {
            let public_url = item
                .get("url")
                .and_then(Value::as_str)
                .and_then(display_url);
            item["url"] = json!(public_url);
        }
    }
    Ok((revision, items))
}

/// Returns list summaries or one object's editable shape, excluding raw credentials.
async fn fetch_parents(
    tx: &mut Transaction<'_, Postgres>,
    resource: Resource,
    f: &Filters<'_>,
) -> Result<Vec<Value>, sqlx::Error> {
    let (parents, models, parent_id, detail) = if matches!(resource, Resource::Providers) {
        (
            "catalog_providers",
            "catalog_provider_models",
            "provider_id",
            "'vendor', p.vendor, 'apiType', p.api_type, 'hasApiKey', p.encrypted_key IS NOT NULL, 'models', children.refs",
        )
    } else {
        (
            "catalog_projects",
            "catalog_project_models",
            "project_id",
            "'meta', p.meta, 'hasApiKey', true, 'callModels', children.refs",
        )
    };
    let sql = format!(
        "SELECT jsonb_build_object('id', p.id, 'name', p.name, 'icon', p.icon, 'modelCount', children.count)
            || CASE WHEN $1::text IS NULL THEN '{{}}'::jsonb
                    ELSE jsonb_build_object({detail}, 'script', p.script) END
         FROM (SELECT * FROM {parents} WHERE ($1::text IS NULL OR id = $1)
               AND ($2::text IS NULL OR strpos(lower(id), lower($2)) > 0 OR strpos(lower(name), lower($2)) > 0)
               ORDER BY position LIMIT $3 OFFSET $4) p
         CROSS JOIN LATERAL (
             SELECT count(*) AS count, coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name)
                 ORDER BY m.position) FILTER (WHERE $1::text IS NOT NULL), '[]'::jsonb) AS refs
             FROM {models} m WHERE m.{parent_id} = p.id
         ) children ORDER BY p.position"
    );
    sqlx::query_scalar(&sql)
        .bind(f.id)
        .bind(f.search)
        .bind(f.limit)
        .bind(f.offset)
        .fetch_all(&mut **tx)
        .await
}

/// Reads models scoped by their parent; model IDs are not globally unique.
async fn fetch_models(
    tx: &mut Transaction<'_, Postgres>,
    resource: Resource,
    f: &Filters<'_>,
) -> Result<Vec<Value>, sqlx::Error> {
    let (parents, models, parent_id, parent, columns, detail) =
        if matches!(resource, Resource::ProviderModels) {
            (
                "catalog_providers",
                "catalog_provider_models",
                "provider_id",
                f.provider,
                "'providerId', p.id, 'providerName', p.name, 'toolCalling', m.tool_calling,
           'vision', m.vision, 'thinking', m.thinking, 'streaming', m.streaming,
           'supportsReasoningEffort', m.supports_reasoning_effort,
           'maxInputTokens', m.max_input_tokens, 'maxOutputTokens', m.max_output_tokens",
                "'url', m.url",
            )
        } else {
            (
                "catalog_projects",
                "catalog_project_models",
                "project_id",
                f.project,
                "'projectId', p.id, 'projectName', p.name",
                "'meta', m.meta",
            )
        };
    let sql = format!(
        "SELECT jsonb_build_object('id', m.id, 'name', m.name, 'icon', m.icon, {columns})
            || CASE WHEN $1::text IS NULL THEN '{{}}'::jsonb
                    ELSE jsonb_build_object({detail}, 'script', m.script) END
         FROM {models} m JOIN {parents} p ON p.id = m.{parent_id}
         WHERE ($1::text IS NULL OR m.id = $1) AND ($2::text IS NULL OR p.id = $2)
           AND ($3::text IS NULL OR strpos(lower(m.id), lower($3)) > 0 OR strpos(lower(m.name), lower($3)) > 0)
         ORDER BY p.position, m.position LIMIT $4 OFFSET $5"
    );
    sqlx::query_scalar(&sql)
        .bind(f.id)
        .bind(parent)
        .bind(f.search)
        .bind(f.limit)
        .bind(f.offset)
        .fetch_all(&mut **tx)
        .await
}

/// Resolves the first enabled match before applying search and pagination.
async fn fetch_routes(
    tx: &mut Transaction<'_, Postgres>,
    f: &Filters<'_>,
) -> Result<Vec<Value>, sqlx::Error> {
    sqlx::query_scalar(
        r"
        WITH matched AS (
            SELECT r.* FROM catalog_route_rules r
            WHERE ($3::text IS NULL OR $3 = ANY(r.project_ids) OR '*' = ANY(r.project_ids))
              AND ($4::text IS NULL OR $4 = ANY(r.call_model_ids) OR '*' = ANY(r.call_model_ids))
              AND ($3::text IS NULL OR $4::text IS NULL OR EXISTS (
                  SELECT 1 FROM catalog_project_models WHERE project_id = $3 AND id = $4
              ))
        ), first_rule AS (
            SELECT id FROM matched WHERE $3::text IS NOT NULL AND $4::text IS NOT NULL AND enabled
            ORDER BY priority DESC, position LIMIT 1
        ), page AS (
            SELECT * FROM matched WHERE ($1::text IS NULL OR id = $1)
                AND ($2::text IS NULL OR strpos(lower(id), lower($2)) > 0 OR strpos(lower(name), lower($2)) > 0)
            ORDER BY priority DESC, position LIMIT $5 OFFSET $6
        )
        SELECT jsonb_build_object('id', r.id, 'name', r.name, 'enabled', r.enabled, 'priority', r.priority,
            'match', jsonb_build_object('projectIds', r.project_ids, 'callModelIds', r.call_model_ids),
            'candidates', jsonb_build_object('allow', r.allow_patterns, 'deny', r.deny_patterns),
            'target', targets.primary_target, 'fallbacks', coalesce(targets.fallbacks, '[]'::jsonb),
            'rewriteResponseModel', r.rewrite_response_model, 'hasScript', r.script IS NOT NULL,
            'firstMatch', coalesce(r.id = (SELECT id FROM first_rule), false))
            || CASE WHEN $1::text IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('script', r.script) END
        FROM page r
        CROSS JOIN LATERAL (
            SELECT (jsonb_agg(item) FILTER (WHERE position = 0))->0 AS primary_target,
                   jsonb_agg(item ORDER BY position) FILTER (WHERE position > 0) AS fallbacks
            FROM (SELECT position, jsonb_build_object('providerId', provider_id, 'modelId', model_id,
                'maxAttempts', max_attempts) AS item FROM catalog_route_targets WHERE route_id = r.id) t
        ) targets
        ORDER BY r.priority DESC, r.position
        ",
    ).bind(f.id).bind(f.search).bind(f.project).bind(f.call_model).bind(f.limit).bind(f.offset)
        .fetch_all(&mut **tx).await
}

/// Leaves a viewable endpoint while stripping userinfo, query credentials and fragments.
fn display_url(value: &str) -> Option<String> {
    let mut url = reqwest::Url::parse(value).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    url.set_username("").ok()?;
    url.set_password(None).ok()?;
    url.set_query(None);
    url.set_fragment(None);
    Some(url.into())
}
