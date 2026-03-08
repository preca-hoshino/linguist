-- Linguist LLM Gateway — 审计上下文重构
-- 将 GatewayContext 作为审计日志的唯一完整载体
-- 移除冗余的独立 body 列（数据已内嵌于 gateway_context JSONB 中）
-- 新增 api_key_prefix 索引列，支持按 API Key 前缀快速筛选

BEGIN;

-- ==================== 新增索引列 ====================
-- API Key 前缀（前11位脱敏后，审计溯源）
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS api_key_prefix VARCHAR(11);

-- ==================== 移除冗余 body 列 ====================
-- 这些数据现在统一存储在 gateway_context JSONB 中:
--   gateway_context.audit.userRequest.body      → 原 request_body
--   gateway_context.audit.userResponse.body     → 原 response_body
--   gateway_context.audit.providerRequest.body  → 原 provider_request_body
--   gateway_context.audit.providerResponse.body → 原 provider_response_body
--   gateway_context.audit.userRequest.headers   → 原 request_headers
ALTER TABLE request_logs DROP COLUMN IF EXISTS request_body;
ALTER TABLE request_logs DROP COLUMN IF EXISTS response_body;
ALTER TABLE request_logs DROP COLUMN IF EXISTS provider_request_body;
ALTER TABLE request_logs DROP COLUMN IF EXISTS provider_response_body;
ALTER TABLE request_logs DROP COLUMN IF EXISTS request_headers;

-- ==================== 新增索引 ====================
CREATE INDEX IF NOT EXISTS idx_rl_api_key_prefix ON request_logs(api_key_prefix);
CREATE INDEX IF NOT EXISTS idx_rl_is_stream      ON request_logs(is_stream);

-- 复合索引：常见查询组合
CREATE INDEX IF NOT EXISTS idx_rl_status_created  ON request_logs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rl_model_created   ON request_logs(request_model, created_at DESC);

COMMIT;
