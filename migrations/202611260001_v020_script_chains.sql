-- Linguist v0.2.0: Add extra_tokens to request_logs and upgrade empty v0.1.0 catalog schemas in-place.
-- Non-empty v0.1.0 catalogs are preserved untouched so `linguist migrate-v02` can transpile them safely.

ALTER TABLE request_logs
    ADD COLUMN IF NOT EXISTS extra_tokens JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
DECLARE
    has_old_write_mode BOOLEAN;
    old_rev BIGINT := 0;
    prov_cnt BIGINT := 0;
    proj_cnt BIGINT := 0;
    route_cnt BIGINT := 0;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'catalog_state'
          AND column_name = 'write_mode'
    ) INTO has_old_write_mode;

    IF NOT has_old_write_mode THEN
        RETURN;
    END IF;

    SELECT revision INTO old_rev FROM catalog_state WHERE singleton;
    SELECT count(*) INTO prov_cnt FROM catalog_providers;
    SELECT count(*) INTO proj_cnt FROM catalog_projects;
    SELECT count(*) INTO route_cnt FROM catalog_route_rules;

    IF COALESCE(old_rev, 0) = 0 AND prov_cnt = 0 AND proj_cnt = 0 AND route_cnt = 0 THEN
        DROP TABLE IF EXISTS catalog_route_targets;
        DROP TABLE IF EXISTS catalog_route_rules;
        DROP TABLE IF EXISTS catalog_project_models;
        DROP TABLE IF EXISTS catalog_projects;
        DROP TABLE IF EXISTS catalog_provider_models;
        DROP TABLE IF EXISTS catalog_providers;
        DROP TABLE IF EXISTS catalog_state;

        CREATE TABLE catalog_state (
            singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
            schema_version INTEGER NOT NULL DEFAULT 2 CHECK (schema_version = 2),
            revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
            key_tag BYTEA CHECK (octet_length(key_tag) = 32),
            billing_fx_rates JSONB,
            updated_at TIMESTAMPTZ
        );
        INSERT INTO catalog_state (singleton, schema_version, revision) VALUES (TRUE, 2, 0);

        CREATE TABLE catalog_providers (
            id TEXT PRIMARY KEY CHECK (btrim(id) <> ''),
            position BIGINT NOT NULL UNIQUE CHECK (position >= 0),
            name TEXT NOT NULL,
            icon TEXT NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            encrypted_key BYTEA,
            scripts JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(scripts) = 'array'),
            derived_tags TEXT[] NOT NULL DEFAULT '{}'::text[],
            derived_meta JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(derived_meta) = 'object'),
            derived_hooks TEXT[] NOT NULL DEFAULT '{}'::text[],
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE catalog_provider_models (
            provider_id TEXT NOT NULL REFERENCES catalog_providers(id) ON DELETE RESTRICT,
            id TEXT NOT NULL CHECK (btrim(id) <> ''),
            position BIGINT NOT NULL CHECK (position >= 0),
            name TEXT NOT NULL,
            icon TEXT NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            scripts JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(scripts) = 'array'),
            derived_tags TEXT[] NOT NULL DEFAULT '{}'::text[],
            derived_meta JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(derived_meta) = 'object'),
            derived_hooks TEXT[] NOT NULL DEFAULT '{}'::text[],
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (provider_id, id),
            UNIQUE (provider_id, position)
        );

        CREATE TABLE catalog_projects (
            id TEXT PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]+$'),
            position BIGINT NOT NULL UNIQUE CHECK (position >= 0),
            name TEXT NOT NULL,
            icon TEXT NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            api_key TEXT NOT NULL CHECK (btrim(api_key) <> ''),
            scripts JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(scripts) = 'array'),
            derived_tags TEXT[] NOT NULL DEFAULT '{}'::text[],
            derived_meta JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(derived_meta) = 'object'),
            derived_hooks TEXT[] NOT NULL DEFAULT '{}'::text[],
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE catalog_project_models (
            project_id TEXT NOT NULL REFERENCES catalog_projects(id) ON DELETE RESTRICT,
            id TEXT NOT NULL CHECK (btrim(id) NOT IN ('', '*')),
            position BIGINT NOT NULL CHECK (position >= 0),
            name TEXT NOT NULL,
            icon TEXT NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            scripts JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(scripts) = 'array'),
            derived_tags TEXT[] NOT NULL DEFAULT '{}'::text[],
            derived_meta JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(derived_meta) = 'object'),
            derived_hooks TEXT[] NOT NULL DEFAULT '{}'::text[],
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (project_id, id),
            UNIQUE (project_id, position)
        );

        CREATE TABLE catalog_route_rules (
            id TEXT PRIMARY KEY CHECK (btrim(id) <> ''),
            position BIGINT NOT NULL UNIQUE CHECK (position >= 0),
            name TEXT NOT NULL,
            icon TEXT NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            scripts JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(scripts) = 'array'),
            derived_tags TEXT[] NOT NULL DEFAULT '{}'::text[],
            derived_meta JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(derived_meta) = 'object'),
            derived_hooks TEXT[] NOT NULL DEFAULT '{}'::text[],
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    END IF;
END $$;
