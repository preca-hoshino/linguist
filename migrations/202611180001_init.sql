-- Linguist pure-log & daily telemetry schema (no config dictionary tables or external config FKs)

CREATE TABLE IF NOT EXISTS request_logs (
    id BIGSERIAL PRIMARY KEY,
    request_uid UUID NOT NULL UNIQUE,
    parent_request_uid UUID NULL,
    attempt_index SMALLINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    project_id VARCHAR(128) NOT NULL,
    project_name VARCHAR(256) NOT NULL,
    call_model_id VARCHAR(256) NOT NULL,
    call_model_name VARCHAR(256) NOT NULL,
    provider_id VARCHAR(128) NOT NULL,
    provider_name VARCHAR(256) NOT NULL,
    model_id VARCHAR(256) NOT NULL,
    model_name VARCHAR(256) NOT NULL,
    route_rule_id VARCHAR(128) NOT NULL,
    is_stream BOOLEAN NOT NULL DEFAULT FALSE,
    status_code INTEGER NOT NULL,
    input_tokens BIGINT NOT NULL DEFAULT 0,
    output_tokens BIGINT NOT NULL DEFAULT 0,
    cache_read_tokens BIGINT NOT NULL DEFAULT 0,
    cache_creation_tokens BIGINT NOT NULL DEFAULT 0,
    reasoning_tokens BIGINT NOT NULL DEFAULT 0,
    total_tokens BIGINT NOT NULL DEFAULT 0,
    ttft_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
    total_duration_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
    generation_duration_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
    decode_tps DOUBLE PRECISION NOT NULL DEFAULT 0,
    e2e_tps DOUBLE PRECISION NOT NULL DEFAULT 0,
    finish_reason VARCHAR(64) NULL,
    reasoning_effort VARCHAR(64) NULL,
    token_source VARCHAR(64) NOT NULL DEFAULT 'upstream_usage',
    script_state JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_request_logs_created_at
    ON request_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_request_logs_project_created
    ON request_logs (project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_request_logs_provider_model_created
    ON request_logs (provider_id, model_id, created_at DESC);

CREATE TABLE IF NOT EXISTS request_payloads (
    request_log_id BIGINT PRIMARY KEY REFERENCES request_logs(id) ON DELETE CASCADE,
    error_message TEXT NULL,
    request_headers JSONB NULL,
    request_body JSONB NULL,
    response_body JSONB NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS daily_model_stats (
    stat_date DATE NOT NULL,
    project_id VARCHAR(128) NOT NULL,
    provider_id VARCHAR(128) NOT NULL,
    model_id VARCHAR(256) NOT NULL,
    provider_name VARCHAR(256) NOT NULL,
    model_name VARCHAR(256) NOT NULL,
    request_count BIGINT NOT NULL DEFAULT 0,
    success_count BIGINT NOT NULL DEFAULT 0,
    input_tokens BIGINT NOT NULL DEFAULT 0,
    output_tokens BIGINT NOT NULL DEFAULT 0,
    cache_read_tokens BIGINT NOT NULL DEFAULT 0,
    cache_creation_tokens BIGINT NOT NULL DEFAULT 0,
    reasoning_tokens BIGINT NOT NULL DEFAULT 0,
    total_tokens BIGINT NOT NULL DEFAULT 0,
    sum_ttft_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
    sum_generation_duration_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (stat_date, project_id, provider_id, model_id)
);

CREATE INDEX IF NOT EXISTS idx_daily_model_stats_date
    ON daily_model_stats (stat_date DESC);

CREATE TABLE IF NOT EXISTS system_events (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    event_type VARCHAR(128) NOT NULL,
    level VARCHAR(32) NOT NULL,
    message TEXT NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb
);
