//! PostgreSQL catalog read projections for the read-write administration console.

use serde_json::Value;
use sqlx::{PgPool, Postgres, Transaction};

use super::postgres::begin_read;

/// Configuration resources exposed by the console.
#[derive(Debug, Clone, Copy)]
pub enum Resource {
    /// Upstream providers.
    Providers,
    /// Models under providers.
    ProviderModels,
    /// Client projects.
    Projects,
    /// Models exposed to a project's clients.
    ProjectModels,
    /// Ordered routing rules.
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
    /// Owning project filter.
    pub(crate) project: Option<&'a str>,
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

    let items = match resource {
        Resource::Providers | Resource::Projects => {
            fetch_parents(&mut tx, resource, filters).await?
        }
        Resource::ProviderModels | Resource::ProjectModels => {
            fetch_models(&mut tx, resource, filters).await?
        }
        Resource::Routes => fetch_routes(&mut tx, filters).await?,
    };
    tx.commit().await?;
    Ok((revision, items))
}

/// Returns list summaries or one parent entity's full editable shape.
/// Note: `projects` detail includes plaintext `apiKey`; `providers` returns only `hasApiKey`.
async fn fetch_parents(
    tx: &mut Transaction<'_, Postgres>,
    resource: Resource,
    f: &Filters<'_>,
) -> Result<Vec<Value>, sqlx::Error> {
    let (parents, models, parent_id, detail_extras) = if matches!(resource, Resource::Providers) {
        (
            "catalog_providers",
            "catalog_provider_models",
            "provider_id",
            "'hasApiKey', p.encrypted_key IS NOT NULL, 'models', children.refs",
        )
    } else {
        (
            "catalog_projects",
            "catalog_project_models",
            "project_id",
            "'apiKey', p.api_key, 'callModels', children.refs",
        )
    };

    let sql = format!(
        "SELECT jsonb_build_object(
            'id', p.id,
            'name', p.name,
            'icon', p.icon,
            'enabled', p.enabled,
            'position', p.position,
            'modelCount', children.count,
            'scriptCount', jsonb_array_length(p.scripts),
            'derivedTags', to_jsonb(p.derived_tags),
            'derivedMeta', p.derived_meta,
            'derivedHooks', to_jsonb(p.derived_hooks)
        ) || CASE WHEN $1::text IS NULL THEN '{{}}'::jsonb
                  ELSE jsonb_build_object({detail_extras}, 'scripts', p.scripts) END
         FROM (
            SELECT * FROM {parents}
            WHERE ($1::text IS NULL OR id = $1)
              AND ($2::text IS NULL OR strpos(lower(id), lower($2)) > 0 OR strpos(lower(name), lower($2)) > 0)
            ORDER BY position ASC
            LIMIT $3 OFFSET $4
         ) p
         CROSS JOIN LATERAL (
            SELECT count(*) AS count,
                   coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name) ORDER BY m.position)
                       FILTER (WHERE $1::text IS NOT NULL), '[]'::jsonb) AS refs
            FROM {models} m WHERE m.{parent_id} = p.id
         ) children
         ORDER BY p.position ASC"
    );

    sqlx::query_scalar(&sql)
        .bind(f.id)
        .bind(f.search)
        .bind(f.limit)
        .bind(f.offset)
        .fetch_all(&mut **tx)
        .await
}

/// Reads models scoped by their parent (`provider_id` or `project_id`).
async fn fetch_models(
    tx: &mut Transaction<'_, Postgres>,
    resource: Resource,
    f: &Filters<'_>,
) -> Result<Vec<Value>, sqlx::Error> {
    let (parents, models, parent_id, parent_filter, parent_cols) =
        if matches!(resource, Resource::ProviderModels) {
            (
                "catalog_providers",
                "catalog_provider_models",
                "provider_id",
                f.provider,
                "'providerId', p.id, 'providerName', p.name",
            )
        } else {
            (
                "catalog_projects",
                "catalog_project_models",
                "project_id",
                f.project,
                "'projectId', p.id, 'projectName', p.name",
            )
        };

    let sql = format!(
        "SELECT jsonb_build_object(
            'id', m.id,
            'name', m.name,
            'icon', m.icon,
            'enabled', m.enabled,
            'position', m.position,
            {parent_cols},
            'scriptCount', jsonb_array_length(m.scripts),
            'derivedTags', to_jsonb(m.derived_tags),
            'derivedMeta', m.derived_meta,
            'derivedHooks', to_jsonb(m.derived_hooks)
        ) || CASE WHEN $1::text IS NULL THEN '{{}}'::jsonb
                  ELSE jsonb_build_object('scripts', m.scripts) END
         FROM {models} m
         JOIN {parents} p ON p.id = m.{parent_id}
         WHERE ($1::text IS NULL OR m.id = $1)
           AND ($2::text IS NULL OR p.id = $2)
           AND ($3::text IS NULL OR strpos(lower(m.id), lower($3)) > 0 OR strpos(lower(m.name), lower($3)) > 0)
         ORDER BY p.position ASC, m.position ASC
         LIMIT $4 OFFSET $5"
    );

    sqlx::query_scalar(&sql)
        .bind(f.id)
        .bind(parent_filter)
        .bind(f.search)
        .bind(f.limit)
        .bind(f.offset)
        .fetch_all(&mut **tx)
        .await
}

/// Reads ordered routing rules.
async fn fetch_routes(
    tx: &mut Transaction<'_, Postgres>,
    f: &Filters<'_>,
) -> Result<Vec<Value>, sqlx::Error> {
    sqlx::query_scalar(
        r"
        SELECT jsonb_build_object(
            'id', r.id,
            'name', r.name,
            'icon', r.icon,
            'enabled', r.enabled,
            'position', r.position,
            'scriptCount', jsonb_array_length(r.scripts),
            'derivedTags', to_jsonb(r.derived_tags),
            'derivedMeta', r.derived_meta,
            'derivedHooks', to_jsonb(r.derived_hooks)
        ) || CASE WHEN $1::text IS NULL THEN '{}'::jsonb
                  ELSE jsonb_build_object('scripts', r.scripts) END
        FROM catalog_route_rules r
        WHERE ($1::text IS NULL OR r.id = $1)
          AND ($2::text IS NULL OR strpos(lower(r.id), lower($2)) > 0 OR strpos(lower(r.name), lower($2)) > 0)
        ORDER BY r.position ASC
        LIMIT $3 OFFSET $4
        ",
    )
    .bind(f.id)
    .bind(f.search)
    .bind(f.limit)
    .bind(f.offset)
    .fetch_all(&mut **tx)
    .await
}
