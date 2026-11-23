CREATE TABLE catalog_state (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    write_mode TEXT NOT NULL DEFAULT 'json_sync' CHECK (write_mode IN ('json_sync', 'postgres')),
    revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
    fingerprint BYTEA CHECK (octet_length(fingerprint) = 32),
    key_tag BYTEA CHECK (octet_length(key_tag) = 32),
    updated_at TIMESTAMPTZ,
    sync_error TEXT
);

INSERT INTO catalog_state DEFAULT VALUES;

CREATE TABLE catalog_providers (
    id TEXT PRIMARY KEY CHECK (btrim(id) <> ''),
    position BIGINT NOT NULL UNIQUE CHECK (position >= 0),
    name TEXT NOT NULL,
    icon TEXT NOT NULL,
    vendor TEXT,
    api_type TEXT,
    encrypted_key BYTEA,
    script TEXT
);

CREATE TABLE catalog_provider_models (
    provider_id TEXT NOT NULL REFERENCES catalog_providers(id),
    id TEXT NOT NULL CHECK (btrim(id) <> ''),
    position BIGINT NOT NULL CHECK (position >= 0),
    name TEXT NOT NULL,
    icon TEXT NOT NULL,
    url TEXT NOT NULL,
    supports_reasoning_effort TEXT[],
    tool_calling BOOLEAN,
    vision BOOLEAN,
    thinking BOOLEAN,
    streaming BOOLEAN,
    max_input_tokens BIGINT CHECK (max_input_tokens >= 0),
    max_output_tokens BIGINT CHECK (max_output_tokens >= 0),
    script TEXT,
    PRIMARY KEY (provider_id, id),
    UNIQUE (provider_id, position)
);

CREATE TABLE catalog_projects (
    id TEXT PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]+$'),
    position BIGINT NOT NULL UNIQUE CHECK (position >= 0),
    name TEXT NOT NULL,
    icon TEXT NOT NULL,
    key_digest BYTEA NOT NULL CHECK (octet_length(key_digest) = 32),
    meta JSONB NOT NULL CHECK (jsonb_typeof(meta) = 'object'),
    script TEXT
);

CREATE TABLE catalog_project_models (
    project_id TEXT NOT NULL REFERENCES catalog_projects(id),
    id TEXT NOT NULL CHECK (btrim(id) NOT IN ('', '*')),
    position BIGINT NOT NULL CHECK (position >= 0),
    name TEXT NOT NULL,
    icon TEXT NOT NULL,
    meta JSONB NOT NULL CHECK (jsonb_typeof(meta) = 'object'),
    script TEXT,
    PRIMARY KEY (project_id, id),
    UNIQUE (project_id, position)
);

CREATE TABLE catalog_route_rules (
    id TEXT PRIMARY KEY CHECK (btrim(id) <> ''),
    position BIGINT NOT NULL UNIQUE CHECK (position >= 0),
    name TEXT NOT NULL,
    enabled BOOLEAN NOT NULL,
    priority INTEGER NOT NULL,
    project_ids TEXT[] NOT NULL,
    call_model_ids TEXT[] NOT NULL,
    allow_patterns TEXT[] NOT NULL,
    deny_patterns TEXT[] NOT NULL,
    rewrite_response_model BOOLEAN NOT NULL,
    script TEXT
);

CREATE TABLE catalog_route_targets (
    route_id TEXT NOT NULL REFERENCES catalog_route_rules(id),
    position BIGINT NOT NULL CHECK (position >= 0),
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    max_attempts SMALLINT NOT NULL CHECK (max_attempts BETWEEN 1 AND 5),
    PRIMARY KEY (route_id, position),
    FOREIGN KEY (provider_id, model_id) REFERENCES catalog_provider_models(provider_id, id)
);

CREATE INDEX catalog_route_targets_model_idx ON catalog_route_targets (provider_id, model_id);
