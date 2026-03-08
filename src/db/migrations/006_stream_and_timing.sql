-- Linguist LLM Gateway — 流式标记 & 细粒度计时
-- 新增 is_stream 字段，标记该请求是否为流式响应
-- timing 字段已为 JSONB，本次不做结构变更，新增阶段时间戳由代码侧写入

BEGIN;

-- ==================== request_logs 新增字段 ====================
-- 是否为流式请求（仅 chat 有效），NULL 表示非 chat 或旧数据
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS is_stream BOOLEAN;

-- 原始请求头快照（脱敏后的 JSONB，用于审计溯源）
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS request_headers JSONB;

COMMIT;
