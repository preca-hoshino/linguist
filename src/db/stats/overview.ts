// src/db/stats/overview.ts — 概览统计查询

import { db } from '@/db/client';
import { createLogger, logColors } from '@/utils';
import { buildDimensionFilterAliased, buildTimeFilter, getWindowMinutes } from './helpers';
import type { StatsOverview, StatsQueryParams } from './types';

const logger = createLogger('Stats', logColors.bold + logColors.blue);

/**
 * 获取概览统计数据
 *
 * 性能优化策略（全热表，零冷表 JOIN）：
 * - stats_base / latency_sample 均直接读取 request_logs 主表的独立列，
 *   无需 JOIN request_log_details，完全消除双分区扫描 + JSONB 解析开销。
 * - latency_sample 限制 1000 条抽样，避免对全量数据执行 PERCENTILE_CONT 计算。
 */
export async function getStatsOverview(params: StatsQueryParams): Promise<StatsOverview> {
  const minutes = getWindowMinutes(params);
  const timeFilter = buildTimeFilter(params, 1);
  const timeClauseAliased = timeFilter.clause.replaceAll('created_at', 'r.created_at');
  const dimFilter = buildDimensionFilterAliased(params.dimension, params.id, timeFilter.nextIdx, 'r');
  const allValues = [...timeFilter.values, ...dimFilter.values];

  const sql = `
    WITH stats_base AS (
      -- 直接读取主表 token 列，单表扫描，无 JOIN，走覆盖索引
      SELECT
        COUNT(*)::int AS total_requests,
        COALESCE(SUM(r.calculated_cost), 0.0)::float AS total_cost,
        COALESCE(SUM(r.prompt_tokens), 0)::bigint AS prompt_tokens,
        COALESCE(SUM(r.completion_tokens), 0)::bigint AS completion_tokens,
        COALESCE(SUM(r.total_tokens), 0)::bigint AS total_tokens,
        COALESCE(SUM(r.cached_tokens), 0)::bigint AS cached_tokens,
        COALESCE(SUM(r.reasoning_tokens), 0)::bigint AS reasoning_tokens,
        COUNT(*) FILTER (WHERE r.status = 'error')::int AS error_count,
        COUNT(*) FILTER (WHERE r.error_type = 'rate_limit')::int AS rate_limit_error_count,
        COUNT(*) FILTER (WHERE r.error_type = 'timeout')::int AS timeout_error_count,
        AVG(r.prompt_tokens)::float AS avg_input_tokens,
        AVG(r.completion_tokens)::float AS avg_output_tokens
      FROM request_logs r
      WHERE ${timeClauseAliased}
      ${dimFilter.clause}
    ),
    latency_sample AS (
      -- 延迟百分位计算：直接读热表列，限 1000 条抽样
      SELECT r.duration_ms, r.ttft_ms, r.completion_tokens, r.provider_duration_ms
      FROM request_logs r
      WHERE ${timeClauseAliased}
      ${dimFilter.clause}
      ORDER BY r.created_at DESC
      LIMIT 1000
    ),
    latency_stats AS (
      SELECT
        AVG(NULLIF(duration_ms, 0))::float AS avg_latency_ms,
        PERCENTILE_CONT(0.95) WITHIN GROUP (
          ORDER BY NULLIF(duration_ms, 0)
        )::float AS p95_latency_ms,
        AVG(NULLIF(provider_duration_ms, 0))::float AS avg_provider_latency_ms,
        -- gateway overhead = duration - provider_duration
        AVG(
          CASE WHEN duration_ms IS NOT NULL AND provider_duration_ms IS NOT NULL
          THEN duration_ms - provider_duration_ms END
        )::float AS gateway_overhead_ms,
        AVG(NULLIF(ttft_ms, 0))::float AS ttft_avg_ms,
        AVG(
          CASE WHEN duration_ms IS NOT NULL AND ttft_ms IS NOT NULL AND completion_tokens IS NOT NULL AND completion_tokens > 0
          THEN (duration_ms - ttft_ms)::float / completion_tokens END
        )::float AS itl_avg_ms
      FROM latency_sample
    )
    SELECT * FROM stats_base CROSS JOIN latency_stats
  `;

  logger.debug({ params, sql: sql.trim().slice(0, 120) }, 'Querying stats overview');

  const result = await db.query<{
    total_requests: number;
    prompt_tokens: string;
    completion_tokens: string;
    total_tokens: string;
    cached_tokens: string;
    reasoning_tokens: string;
    error_count: number;
    rate_limit_error_count: number;
    timeout_error_count: number;
    avg_latency_ms: number | null;
    p95_latency_ms: number | null;
    avg_provider_latency_ms: number | null;
    gateway_overhead_ms: number | null;
    avg_input_tokens: number | null;
    avg_output_tokens: number | null;
    ttft_avg_ms: number | null;
    itl_avg_ms: number | null;
    total_cost: number;
  }>(sql, allValues);

  const row = result.rows[0];
  if (!row) {
    return {
      total_requests: 0,
      rpm: 0,
      total_tokens: 0,
      tpm: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      reasoning_tokens: 0,
      cached_tokens: 0,
      cache_hit_rate: 0,
      error_count: 0,
      error_rate: 0,
      rate_limit_error_count: 0,
      rate_limit_error_rate: 0,
      timeout_error_count: 0,
      timeout_error_rate: 0,
      avg_latency_ms: null,
      p95_latency_ms: null,
      avg_provider_latency_ms: null,
      gateway_overhead_ms: null,
      avg_input_tokens_per_req: null,
      avg_output_tokens_per_req: null,
      ttft_avg_ms: null,
      itl_avg_ms: null,
      total_cost: 0,
    };
  }

  const totalReqs = row.total_requests;
  const promptTokens = Number(row.prompt_tokens);
  const completionTokens = Number(row.completion_tokens);
  const totalTokens = Number(row.total_tokens);
  const cachedTokens = Number(row.cached_tokens);
  const reasoningTokens = Number(row.reasoning_tokens);

  return {
    total_requests: totalReqs,
    rpm: totalReqs > 0 ? Math.round((totalReqs / minutes) * 100) / 100 : 0,
    total_tokens: totalTokens,
    tpm: totalTokens > 0 ? Math.round((totalTokens / minutes) * 100) / 100 : 0,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    reasoning_tokens: reasoningTokens,
    cached_tokens: cachedTokens,
    cache_hit_rate: promptTokens > 0 ? Math.round((cachedTokens / promptTokens) * 10_000) / 10_000 : 0,
    error_count: row.error_count,
    error_rate: totalReqs > 0 ? Math.round((row.error_count / totalReqs) * 10_000) / 10_000 : 0,
    rate_limit_error_count: row.rate_limit_error_count,
    rate_limit_error_rate: totalReqs > 0 ? Math.round((row.rate_limit_error_count / totalReqs) * 10_000) / 10_000 : 0,
    timeout_error_count: row.timeout_error_count,
    timeout_error_rate: totalReqs > 0 ? Math.round((row.timeout_error_count / totalReqs) * 10_000) / 10_000 : 0,
    avg_latency_ms: row.avg_latency_ms === null ? null : Math.round(row.avg_latency_ms),
    p95_latency_ms: row.p95_latency_ms === null ? null : Math.round(row.p95_latency_ms),
    avg_provider_latency_ms: row.avg_provider_latency_ms === null ? null : Math.round(row.avg_provider_latency_ms),
    gateway_overhead_ms: row.gateway_overhead_ms === null ? null : Math.round(row.gateway_overhead_ms),
    avg_input_tokens_per_req: row.avg_input_tokens === null ? null : Math.round(row.avg_input_tokens),
    avg_output_tokens_per_req: row.avg_output_tokens === null ? null : Math.round(row.avg_output_tokens),
    ttft_avg_ms: row.ttft_avg_ms === null ? null : Math.round(row.ttft_avg_ms),
    itl_avg_ms: row.itl_avg_ms === null ? null : Math.round(row.itl_avg_ms),
    total_cost: Math.round(row.total_cost * 1_000_000) / 1_000_000,
  };
}
