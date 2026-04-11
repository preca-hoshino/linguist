-- Linguist LLM Gateway — Schema: 02 Indexes
-- 定义系统所需的所有联合索引与常规查询索引
-- 本文件需严格保持幂等性

BEGIN;

-- ==================== 01: 用户系统与鉴权核心 ====================
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);
CREATE INDEX IF NOT EXISTS idx_users_email  ON users(email);

CREATE INDEX IF NOT EXISTS idx_ak_active        ON api_keys(is_active);
CREATE INDEX IF NOT EXISTS idx_ak_prefix        ON api_keys(key_prefix);
CREATE INDEX IF NOT EXISTS idx_ak_app_id        ON api_keys(app_id);
CREATE INDEX IF NOT EXISTS idx_ak_key_value     ON api_keys(key_value);

CREATE INDEX IF NOT EXISTS idx_apps_active      ON apps(is_active);
CREATE INDEX IF NOT EXISTS idx_aam_app          ON app_allowed_models(app_id);
CREATE INDEX IF NOT EXISTS idx_aam_model        ON app_allowed_models(virtual_model_id);

-- ==================== 02: 核心业务模型与路由 ====================
CREATE INDEX IF NOT EXISTS idx_providers_kind           ON providers(kind);
CREATE INDEX IF NOT EXISTS idx_pm_provider              ON provider_models(provider_id);
CREATE INDEX IF NOT EXISTS idx_pm_type                  ON provider_models(model_type);
CREATE INDEX IF NOT EXISTS idx_pm_active                ON provider_models(is_active);
CREATE INDEX IF NOT EXISTS idx_vm_active                ON virtual_models(is_active);
CREATE INDEX IF NOT EXISTS idx_vmb_virtual_model        ON virtual_model_backends(virtual_model_id);
CREATE INDEX IF NOT EXISTS idx_vmb_provider_model       ON virtual_model_backends(provider_model_id);

-- ==================== 03: 分析审计与冷热数据 ====================
CREATE INDEX IF NOT EXISTS idx_rl_status             ON request_logs(status);
CREATE INDEX IF NOT EXISTS idx_rl_provider_id        ON request_logs(provider_id);
CREATE INDEX IF NOT EXISTS idx_rl_error_type         ON request_logs(error_type);
CREATE INDEX IF NOT EXISTS idx_rl_is_stream          ON request_logs(is_stream);
CREATE INDEX IF NOT EXISTS idx_rl_created_at         ON request_logs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_rl_status_created           ON request_logs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rl_provider_created         ON request_logs(provider_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rl_routed_model_created     ON request_logs(routed_model, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rl_apikey_created           ON request_logs(api_key_prefix, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rl_request_model_created    ON request_logs(request_model, created_at DESC);

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_rl_request_model_trgm       ON request_logs USING gin (request_model gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_rld_gateway_context_gin      ON request_logs_details USING GIN (gateway_context);
CREATE INDEX IF NOT EXISTS idx_rld_user_format              ON request_logs_details ((gateway_context->>'userFormat'));

COMMIT;
