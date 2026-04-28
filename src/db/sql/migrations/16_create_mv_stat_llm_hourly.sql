-- Migration 16: 引入按业务域解耦的统计物化视图架构
-- 创建 LLM 请求的 hourly 预聚合视图，作为大范围时序统计的唯一信源

BEGIN;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_stat_llm_hourly AS
SELECT
  date_trunc('hour', created_at) AS bucket_time,
  app_id,
  app_name,
  provider_id,
  routed_model,
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
-- 只聚合有效状态（根据业务需要，如果有未完成状态可以排除，但为保证数据一致性此处不过滤）
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9
WITH DATA;

-- 建立跨维度加速索引，由于查询总是需要带时间范围，将 bucket_time 放第一位
CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_stat_llm_hourly_unique
  ON mv_stat_llm_hourly (bucket_time, app_id, provider_id, routed_model, status, error_type, user_format);

COMMIT;
