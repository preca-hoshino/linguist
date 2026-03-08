-- Linguist LLM Gateway — 统计分析增强字段
-- 补充 cached_tokens、reasoning_tokens、error_type 落库

BEGIN;

-- ==================== request_logs 新增统计字段 ====================
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS cached_tokens INT;
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS reasoning_tokens INT;
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS error_type VARCHAR(20);

-- error_type 仅在 status='error' 时填充，值域：
--   rate_limit       — 提供商限流
--   timeout          — 请求超时
--   provider_error   — 提供商返回错误
--   auth_error       — 鉴权错误
--   invalid_request  — 无效请求
--   internal_error   — 网关内部错误

-- ==================== 索引 ====================
CREATE INDEX IF NOT EXISTS idx_rl_error_type ON request_logs(error_type);

COMMIT;
