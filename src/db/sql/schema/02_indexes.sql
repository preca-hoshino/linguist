-- Linguist LLM Gateway — Schema: 02 Indexes
-- 定义系统所需的所有联合索引与常规查询索引
-- 本文件需严格保持幂等性

BEGIN;

-- ==================== 01: 用户系统与鉴权核心 ====================
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);
CREATE INDEX IF NOT EXISTS idx_users_email  ON users(email);

CREATE INDEX IF NOT EXISTS idx_apps_active      ON apps(is_active);
CREATE INDEX IF NOT EXISTS idx_aam_app          ON app_virtual_models(app_id);
CREATE INDEX IF NOT EXISTS idx_aam_model        ON app_virtual_models(virtual_model_id);

-- ==================== 02: 核心业务模型与路由 ====================
CREATE INDEX IF NOT EXISTS idx_model_providers_kind      ON model_providers(kind);
CREATE INDEX IF NOT EXISTS idx_mpm_provider              ON model_provider_models(provider_id);
CREATE INDEX IF NOT EXISTS idx_mpm_type                  ON model_provider_models(model_type);
CREATE INDEX IF NOT EXISTS idx_mpm_active                ON model_provider_models(is_active);
CREATE INDEX IF NOT EXISTS idx_vm_active                 ON virtual_models(is_active);
CREATE INDEX IF NOT EXISTS idx_vmb_virtual_model         ON virtual_model_backends(virtual_model_id);
CREATE INDEX IF NOT EXISTS idx_vmb_provider_model        ON virtual_model_backends(provider_model_id);

-- ==================== 03: 模型请求日志冷热分离索引 ====================
CREATE INDEX IF NOT EXISTS idx_rl_status             ON request_logs(status);
CREATE INDEX IF NOT EXISTS idx_rl_provider_id        ON request_logs(provider_id);
CREATE INDEX IF NOT EXISTS idx_rl_error_type         ON request_logs(error_type);
CREATE INDEX IF NOT EXISTS idx_rl_is_stream          ON request_logs(is_stream);
CREATE INDEX IF NOT EXISTS idx_rl_created_at         ON request_logs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_rl_status_created           ON request_logs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rl_provider_created         ON request_logs(provider_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rl_routed_model_created     ON request_logs(routed_model, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rl_appid_created            ON request_logs(app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rl_request_model_created    ON request_logs(request_model, created_at DESC);

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_rl_request_model_trgm       ON request_logs USING gin (request_model gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_rld_gateway_context_gin      ON request_log_details USING GIN (gateway_context);
CREATE INDEX IF NOT EXISTS idx_rld_user_format              ON request_log_details ((gateway_context->>'userFormat'));

-- ==================== 04: MCP 日志冷热分离索引 ====================
-- mcp_logs 窄热表：常用列覆盖索引（对标 request_logs 侧索引策略）
CREATE INDEX IF NOT EXISTS idx_mcpl_virtual_mcp_created  ON mcp_logs(virtual_mcp_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcpl_provider_created     ON mcp_logs(mcp_provider_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcpl_app_created          ON mcp_logs(app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcpl_status               ON mcp_logs(status);
CREATE INDEX IF NOT EXISTS idx_mcpl_method               ON mcp_logs(method);
CREATE INDEX IF NOT EXISTS idx_mcpl_tool_name            ON mcp_logs(tool_name);
CREATE INDEX IF NOT EXISTS idx_mcpl_created_at           ON mcp_logs(created_at DESC);

-- mcp_log_details 冷表：GIN 索引支持 JSONB 内部字段查询
CREATE INDEX IF NOT EXISTS idx_mcpld_mcp_context_gin     ON mcp_log_details USING GIN (mcp_context);

COMMIT;

