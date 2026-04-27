-- src/db/sql/migrations/17_add_request_model_to_mv.sql

BEGIN;

DROP MATERIALIZED VIEW IF EXISTS mv_stat_llm_hourly;

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

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_stat_llm_hourly_unique
  ON mv_stat_llm_hourly (bucket_time, app_id, provider_id, routed_model, request_model, status, error_type, user_format);

COMMIT;
