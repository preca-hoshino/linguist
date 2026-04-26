-- Migration 09: 将高频统计字段提升为 request_logs 窄表独立列
-- 目的：消除统计 API 和日志列表对 request_log_details 宽表的 JOIN 依赖
BEGIN;

ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS duration_ms INTEGER DEFAULT NULL;
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS ttft_ms INTEGER DEFAULT NULL;
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS provider_duration_ms INTEGER DEFAULT NULL;
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS user_format VARCHAR(20) DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_rl_user_format ON request_logs(user_format);
CREATE INDEX IF NOT EXISTS idx_rl_duration_ms ON request_logs(duration_ms);

COMMIT;
