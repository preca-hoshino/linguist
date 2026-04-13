-- Linguist LLM Gateway — Schema: 12 Add app_id to mcp_logs
-- 为 MCP 日志表增加请求的应用来源标识
-- 本文件需严格保持幂等性

BEGIN;

ALTER TABLE mcp_logs ADD COLUMN IF NOT EXISTS app_id VARCHAR(32);

COMMIT;
