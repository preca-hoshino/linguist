-- Migration 14: 统计聚合覆盖索引
-- 目标：让统计查询（overview/today/time-series/breakdown）完全走覆盖索引，
-- 消灭 Heap Fetch，亿级数据下实现毫秒级聚合。
-- 所有索引使用 INCLUDE 子句，仅 PostgreSQL 11+ 支持。

BEGIN;

-- ==================== 统计聚合主覆盖索引 ====================
-- 覆盖 getStatsOverview / getStatsTimeSeries 全局查询
-- created_at DESC 匹配 ORDER BY r.created_at DESC
CREATE INDEX IF NOT EXISTS idx_rl_covering_stats
  ON request_logs (created_at DESC)
  INCLUDE (
    status, error_type,
    total_tokens, prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens,
    calculated_cost,
    duration_ms, ttft_ms, provider_duration_ms
  );

-- ==================== 按 app_id 过滤的覆盖索引 ====================
-- 覆盖 breakdownByApp / getStatsToday(app) / getStatsOverview(app)
CREATE INDEX IF NOT EXISTS idx_rl_covering_app_stats
  ON request_logs (app_id, created_at DESC)
  INCLUDE (
    status, error_type, app_name,
    total_tokens, prompt_tokens, completion_tokens, cached_tokens,
    calculated_cost,
    duration_ms, ttft_ms, provider_duration_ms
  );

-- ==================== 按 provider_id 过滤的覆盖索引 ====================
-- 覆盖 breakdownByProvider / breakdownByProviderModel
CREATE INDEX IF NOT EXISTS idx_rl_covering_provider_stats
  ON request_logs (provider_id, created_at DESC)
  INCLUDE (
    status, error_type, routed_model, provider_kind,
    total_tokens, completion_tokens, calculated_cost,
    duration_ms, ttft_ms, provider_duration_ms
  );

-- ==================== user_format 列表过滤索引 ====================
-- 覆盖 queryRequestLogs(user_format filter) 和 breakdownGeneric(user_format)
CREATE INDEX IF NOT EXISTS idx_rl_user_format
  ON request_logs (user_format, created_at DESC);

COMMIT;
