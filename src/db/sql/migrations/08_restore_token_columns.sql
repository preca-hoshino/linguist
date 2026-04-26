-- Migration: 08_restore_token_columns
-- 将 token 统计字段恢复至 request_logs 主表（热表），恢复聚合查询性能
--
-- 背景：
--   Migration 07 将 prompt_tokens / completion_tokens / total_tokens /
--   cached_tokens / reasoning_tokens 五列从 request_logs 热表中删除，
--   导致所有统计端点被迫改写为：
--     FROM request_logs r LEFT JOIN request_logs_details d ON r.id = d.id
--     WHERE ... SUM((d.gateway_context->'response'->'usage'->>'prompt_tokens')::bigint)
--   该模式引入了：
--     1. 强制跨表 JOIN（双分区表）
--     2. 每行 JSONB 路径解析开销（反序列化 + 路径提取 + 类型转换）
--     3. details 表缺少时间范围索引导致全分区 PK Scan
--   性能劣化幅度约 5~20×。
--
-- 修复策略：
--   在主表恢复这 5 列作为"冗余统计列"（热数据），由写入层在
--   markCompleted 时同步写入，聚合查询改为直接读取主表列。
--   request_logs_details.gateway_context 中的详细数据保留不动
--   （用于日志详情展示和审计），两者各司其职、互不干扰。
--
-- 回填策略：
--   从 request_logs_details.gateway_context JSON 路径提取并回写，
--   使存量历史数据与新格式兼容。
--   条件：status = 'completed'（仅成功请求有 usage 数据）
--   幂等性：通过 WHERE prompt_tokens IS NULL 保证重复执行安全。
--
-- 注意：request_logs 为分区表，ALTER TABLE 自动级联至所有子分区。

BEGIN;

-- ==================== 1. 恢复列定义 ====================
ALTER TABLE request_logs
  ADD COLUMN IF NOT EXISTS prompt_tokens     BIGINT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS completion_tokens BIGINT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS total_tokens      BIGINT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS cached_tokens     BIGINT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS reasoning_tokens  BIGINT DEFAULT NULL;

-- ==================== 2. 历史数据回填 ====================
-- 仅回填 status='completed' 且 token 列尚为 NULL 的行（幂等）
UPDATE request_logs r
SET
  prompt_tokens     = (d.gateway_context->'response'->'usage'->>'prompt_tokens')::bigint,
  completion_tokens = (d.gateway_context->'response'->'usage'->>'completion_tokens')::bigint,
  total_tokens      = (d.gateway_context->'response'->'usage'->>'total_tokens')::bigint,
  cached_tokens     = (d.gateway_context->'response'->'usage'->>'cached_tokens')::bigint,
  reasoning_tokens  = (d.gateway_context->'response'->'usage'->>'reasoning_tokens')::bigint
FROM request_logs_details d
WHERE r.id = d.id
  AND r.status = 'completed'
  AND r.prompt_tokens IS NULL
  AND d.gateway_context->'response'->'usage' IS NOT NULL;

-- ==================== 3. 新增聚合专用复合索引 ====================
-- 覆盖索引：时间范围过滤后直接在索引层聚合 token 列，无需回表
CREATE INDEX IF NOT EXISTS idx_rl_created_tokens
  ON request_logs (created_at DESC)
  INCLUDE (prompt_tokens, completion_tokens, total_tokens, cached_tokens, reasoning_tokens, calculated_cost, status, error_type);

-- 复合索引：支持 breakdown(provider_model) 的分组聚合
CREATE INDEX IF NOT EXISTS idx_rl_provider_routed_created
  ON request_logs (provider_id, routed_model, created_at DESC)
  INCLUDE (prompt_tokens, completion_tokens, total_tokens, calculated_cost, status);

-- 复合索引：支持 breakdown(virtual_model/error_type) 的分组聚合
CREATE INDEX IF NOT EXISTS idx_rl_request_model_created_incl
  ON request_logs (request_model, created_at DESC)
  INCLUDE (total_tokens, calculated_cost, status);

COMMIT;
