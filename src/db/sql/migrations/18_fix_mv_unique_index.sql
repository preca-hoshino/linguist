-- src/db/sql/migrations/18_fix_mv_unique_index.sql
-- 修复 mv_stat_llm_hourly 的唯一索引：Migration 17 重建 MV 时引入了 request_model 和 provider_kind 列，
-- 但 UNIQUE INDEX 漏掉了 app_name 和 provider_kind，导致 REFRESH CONCURRENTLY 失败，物化视图数据冻结。
-- 本次迁移重建 MV 并使用与 GROUP BY 完全对应的 10 列唯一索引。

BEGIN;

-- 删除旧视图（索引随之自动删除）
DROP MATERIALIZED VIEW IF EXISTS mv_stat_llm_hourly;

-- 重建物化视图（与 Migration 17 相同的 SELECT / GROUP BY）
CREATE MATERIALIZED VIEW mv_stat_llm_hourly AS
SELECT
  date_trunc('hour', created_at) AS bucket_time,
  app_id,
  app_name,
  provider_id,
  routed_model,
  request_model,
  provider_kind,
  status,
  error_type,
  user_format,

  -- Metrics
  COUNT(*) AS req_count,
  SUM(total_tokens) AS sum_total_tokens,
  SUM(prompt_tokens) AS sum_prompt_tokens,
  SUM(completion_tokens) AS sum_completion_tokens,
  SUM(cached_tokens) AS sum_cached_tokens,
  SUM(calculated_cost) AS sum_calculated_cost,
  SUM(duration_ms) AS sum_duration_ms,
  SUM(ttft_ms) AS sum_ttft_ms,
  SUM(provider_duration_ms) AS sum_provider_duration_ms
FROM request_logs
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
WITH DATA;

-- 重建唯一索引：覆盖全部 GROUP BY 维度（共 10 列），确保 REFRESH CONCURRENTLY 可正常执行
CREATE UNIQUE INDEX idx_mv_stat_llm_hourly_unique
  ON mv_stat_llm_hourly (
    bucket_time,
    app_id,
    app_name,
    provider_id,
    routed_model,
    request_model,
    provider_kind,
    status,
    error_type,
    user_format
  );

COMMIT;
