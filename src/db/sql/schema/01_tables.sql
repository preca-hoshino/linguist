-- Linguist LLM Gateway — Schema: 01 Tables
-- 定义数据库所有的核心表结构实体及其原生依赖（例如分区）
-- 本文件需严格保持幂等性

BEGIN;

CREATE TABLE IF NOT EXISTS users (
    id            VARCHAR(32)   PRIMARY KEY,
    username      VARCHAR(50)  UNIQUE NOT NULL,
    email         VARCHAR(200) UNIQUE NOT NULL,
    password_hash TEXT         NOT NULL,
    avatar_data   TEXT         DEFAULT '',
    is_active     BOOLEAN      DEFAULT true,
    created_at    TIMESTAMPTZ  DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS providers (
    id              VARCHAR(32)   PRIMARY KEY,
    name            VARCHAR(100) NOT NULL,
    kind            VARCHAR(50)  NOT NULL,
    base_url        TEXT         NOT NULL,
    credential_type VARCHAR(20)  NOT NULL DEFAULT 'api_key',
    credential      JSONB        DEFAULT '{}'::jsonb,
    config          JSONB        DEFAULT '{"enable_retry": false, "max_retries": 1, "timeout_ms": 30000, "custom_headers": {}, "http_proxy": ""}'::jsonb,
    created_at      TIMESTAMPTZ  DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS provider_models (
    id              VARCHAR(32)   PRIMARY KEY,
    provider_id     VARCHAR(32)   NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    name            VARCHAR(200) NOT NULL,
    model_type      VARCHAR(20)  NOT NULL CHECK (model_type IN ('chat', 'embedding')),
    capabilities    TEXT[]       DEFAULT '{}',
    parameters      JSONB        DEFAULT '{}'::jsonb,
    max_tokens      INTEGER      DEFAULT 128,
    pricing_tiers   JSONB        DEFAULT '[]'::jsonb,
    rpm_limit       INT          DEFAULT NULL,
    tpm_limit       INT          DEFAULT NULL,
    model_config    JSONB        DEFAULT '{}'::jsonb,
    is_active       BOOLEAN      DEFAULT true,
    created_at      TIMESTAMPTZ  DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  DEFAULT NOW(),
    UNIQUE(provider_id, name)
);

CREATE TABLE IF NOT EXISTS virtual_models (
    id                  VARCHAR(100) PRIMARY KEY,
    name                VARCHAR(200) NOT NULL,
    description         TEXT         DEFAULT '',
    model_type          VARCHAR(20)  NOT NULL DEFAULT 'chat'
                        CHECK (model_type IN ('chat', 'embedding')),
    routing_strategy    VARCHAR(20)  NOT NULL DEFAULT 'load_balance'
                        CHECK (routing_strategy IN ('load_balance', 'failover')),
    rpm_limit           INT          DEFAULT NULL,
    tpm_limit           INT          DEFAULT NULL,
    is_active           BOOLEAN      DEFAULT true,
    created_at          TIMESTAMPTZ  DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS virtual_model_backends (
    id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    virtual_model_id    VARCHAR(100) NOT NULL REFERENCES virtual_models(id) ON DELETE CASCADE,
    provider_model_id   VARCHAR(32)   NOT NULL REFERENCES provider_models(id) ON DELETE CASCADE,
    weight              INT          NOT NULL DEFAULT 1,
    priority            INT          NOT NULL DEFAULT 0,
    UNIQUE(virtual_model_id, provider_model_id)
);

CREATE TABLE IF NOT EXISTS request_logs (
    id                      VARCHAR(36)    NOT NULL,
    status                  VARCHAR(20)    NOT NULL DEFAULT 'processing'
                            CHECK (status IN ('processing', 'completed', 'error')),
    ip                      TEXT,
    request_model           VARCHAR(200),
    routed_model            VARCHAR(200),
    provider_kind           VARCHAR(50),
    provider_id             VARCHAR(32)     REFERENCES providers(id) ON DELETE SET NULL,
    api_key_prefix          VARCHAR(11),
    is_stream               BOOLEAN,
    error_message           TEXT,
    error_code              VARCHAR(50),
    error_type              VARCHAR(20),
    prompt_tokens           INT,
    completion_tokens       INT,
    total_tokens            INT,
    cached_tokens           INT,
    reasoning_tokens        INT,
    calculated_cost         DECIMAL(16,6)  DEFAULT 0.0,
    created_at              TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE IF NOT EXISTS request_logs_details (
    id                      VARCHAR(36)    NOT NULL,
    gateway_context         JSONB,
    timing                  JSONB,
    cost_breakdown          JSONB,
    created_at              TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE IF NOT EXISTS request_logs_2026_01 PARTITION OF request_logs FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE IF NOT EXISTS request_logs_2026_02 PARTITION OF request_logs FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE IF NOT EXISTS request_logs_2026_03 PARTITION OF request_logs FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE IF NOT EXISTS request_logs_2026_04 PARTITION OF request_logs FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE IF NOT EXISTS request_logs_2026_05 PARTITION OF request_logs FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE IF NOT EXISTS request_logs_2026_06 PARTITION OF request_logs FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS request_logs_2026_h2 PARTITION OF request_logs FOR VALUES FROM ('2026-07-01') TO ('2027-01-01');
CREATE TABLE IF NOT EXISTS request_logs_default PARTITION OF request_logs DEFAULT;

CREATE TABLE IF NOT EXISTS request_logs_details_2026_01 PARTITION OF request_logs_details FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE IF NOT EXISTS request_logs_details_2026_02 PARTITION OF request_logs_details FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE IF NOT EXISTS request_logs_details_2026_03 PARTITION OF request_logs_details FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE IF NOT EXISTS request_logs_details_2026_04 PARTITION OF request_logs_details FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE IF NOT EXISTS request_logs_details_2026_05 PARTITION OF request_logs_details FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE IF NOT EXISTS request_logs_details_2026_06 PARTITION OF request_logs_details FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS request_logs_details_2026_h2 PARTITION OF request_logs_details FOR VALUES FROM ('2026-07-01') TO ('2027-01-01');
CREATE TABLE IF NOT EXISTS request_logs_details_default PARTITION OF request_logs_details DEFAULT;

CREATE TABLE IF NOT EXISTS apps (
    id              VARCHAR(32)   PRIMARY KEY,
    name            VARCHAR(200) NOT NULL,
    auth_mode       VARCHAR(20)  NOT NULL DEFAULT 'api_key'
                    CHECK (auth_mode IN ('api_key')),
    is_active       BOOLEAN      DEFAULT true,
    created_at      TIMESTAMPTZ  DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_allowed_models (
    app_id           VARCHAR(32)   NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    virtual_model_id VARCHAR(100) NOT NULL REFERENCES virtual_models(id) ON DELETE CASCADE,
    PRIMARY KEY (app_id, virtual_model_id)
);

CREATE TABLE IF NOT EXISTS api_keys (
    id          VARCHAR(32)   PRIMARY KEY,
    app_id      VARCHAR(32)   NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    name        VARCHAR(200) NOT NULL,
    key_value   TEXT         NOT NULL UNIQUE,
    key_prefix  VARCHAR(20)  NOT NULL,
    is_active   BOOLEAN      DEFAULT true,
    expires_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ  DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  DEFAULT NOW()
);

COMMIT;
