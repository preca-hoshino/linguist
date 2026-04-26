// src/db/stats/today.ts — 今日实时统计查询

import { db } from '@/db/client';
import { buildDimensionFilterAliased, latencyExpr, roundOrNull, safeRate } from './helpers';
import type { StatsDimension, StatsToday } from './types';

/**
 * 获取今日实时统计（大数字卡片）
 * 同一次查询返回「今日累计」和「近期实时值」，前端轮询此端点刷新卡片。
 *
 * 性能优化策略：
 * - today / recent_1m / recent_5m CTE 中的 token 汇总直接读主表统计列（prompt_tokens 等），
 *   无需 JOIN request_logs_details，大幅降低 I/O 和 JSONB 解析开销。
 * - today_latency_sample 仍需 JOIN details 表获取 timing JSON，但限 1000 条抽样。
 * - recent_5m 也需 JOIN details 以计算延迟均值（timing），其余字段走主表列。
 */
export async function getStatsToday(dimension: StatsDimension, id?: string): Promise<StatsToday> {
  const dimFilter = buildDimensionFilterAliased(dimension, id, 1, 'r');
  const sql = `
    WITH today AS (
      -- 今日累计：token 直接读主表列，单表扫描
      SELECT
        COUNT(*)::int AS total_reqs,
        COALESCE(SUM(r.total_tokens), 0)::bigint AS total_tokens,
        COALESCE(SUM(r.prompt_tokens), 0)::bigint AS prompt_tokens,
        COALESCE(SUM(r.completion_tokens), 0)::bigint AS completion_tokens,
        COUNT(*) FILTER (WHERE r.status = 'error')::int AS total_errors,
        COALESCE(SUM(r.calculated_cost), 0.0)::float AS today_cost
      FROM request_logs r
      WHERE r.created_at >= date_trunc('day', NOW())
      ${dimFilter.clause}
    ),
    today_latency_sample AS (
      -- 延迟百分位：仅需 timing JSON，限 1000 条抽样
      SELECT d.timing, r.completion_tokens
      FROM request_logs r
      JOIN request_logs_details d ON r.id = d.id
      WHERE r.created_at >= date_trunc('day', NOW())
      ${dimFilter.clause}
      ORDER BY r.created_at DESC LIMIT 1000
    ),
    today_latency AS (
      SELECT 
        AVG(
          CASE WHEN s.timing->>'end' IS NOT NULL AND s.timing->>'start' IS NOT NULL
          THEN (s.timing->>'end')::float - (s.timing->>'start')::float END
        )::float AS today_avg_latency,
        AVG(
          CASE WHEN s.timing->>'ttft' IS NOT NULL AND s.timing->>'start' IS NOT NULL
          THEN (s.timing->>'ttft')::float - (s.timing->>'start')::float END
        )::float AS today_avg_ttft,
        AVG(
          CASE WHEN s.timing->>'end' IS NOT NULL AND s.timing->>'ttft' IS NOT NULL AND s.completion_tokens IS NOT NULL
          THEN ((s.timing->>'end')::float - (s.timing->>'ttft')::float) / NULLIF(s.completion_tokens, 0) END
        )::float AS today_avg_itl
      FROM today_latency_sample s
    ),
    recent_1m AS (
      -- 近 1 分钟：token 直接读主表列
      SELECT
        COUNT(*)::int AS reqs,
        COALESCE(SUM(r.total_tokens), 0)::bigint AS tokens
      FROM request_logs r
      WHERE r.created_at >= NOW() - INTERVAL '1 minute'
      ${dimFilter.clause}
    ),
    recent_5m AS (
      -- 近 5 分钟：token/cached/prompt 直接读主表列，JOIN details 仅用于计算延迟
      SELECT
        AVG(${latencyExpr('d')})::float AS recent_avg_latency,
        COUNT(*) FILTER (WHERE r.status = 'error')::int AS errors,
        COUNT(*)::int AS total,
        COALESCE(SUM(r.cached_tokens), 0)::bigint AS cached,
        COALESCE(SUM(r.prompt_tokens), 0)::bigint AS prompt,
        COALESCE(SUM(r.total_tokens), 0)::bigint AS tokens
      FROM request_logs r
      LEFT JOIN request_logs_details d ON r.id = d.id
      WHERE r.created_at >= NOW() - INTERVAL '5 minutes'
      ${dimFilter.clause}
    )
    SELECT
      t.total_reqs, t.total_tokens, t.prompt_tokens, t.completion_tokens, t.total_errors,
      tl.today_avg_latency, tl.today_avg_ttft, tl.today_avg_itl, t.today_cost,
      r1.reqs AS rpm_reqs, r1.tokens AS rpm_tokens,
      r5.recent_avg_latency, r5.errors AS r5_errors, r5.total AS r5_total,
      r5.cached AS r5_cached, r5.prompt AS r5_prompt, r5.tokens AS r5_tokens
    FROM today t CROSS JOIN today_latency tl CROSS JOIN recent_1m r1 CROSS JOIN recent_5m r5
  `;

  const result = await db.query<{
    total_reqs: number;
    total_tokens: string;
    prompt_tokens: string;
    completion_tokens: string;
    total_errors: number;
    rpm_reqs: number;
    rpm_tokens: string;
    today_avg_latency: number | null;
    today_avg_ttft: number | null;
    today_avg_itl: number | null;
    today_cost: number;
    recent_avg_latency: number | null;
    r5_errors: number;
    r5_total: number;
    r5_cached: string;
    r5_prompt: string;
    r5_tokens: string;
  }>(sql, dimFilter.values);

  const row = result.rows[0];
  if (!row) {
    return {
      today_requests: 0,
      today_tokens: 0,
      today_prompt_tokens: 0,
      today_completion_tokens: 0,
      today_errors: 0,
      current_rpm: 0,
      current_tpm: 0,
      current_avg_latency_ms: null,
      today_avg_latency_ms: null,
      today_avg_ttft_ms: null,
      today_avg_itl_ms: null,
      current_error_rate: 0,
      current_cache_hit_rate: 0,
      today_cost: 0,
    };
  }

  return {
    today_requests: row.total_reqs,
    today_tokens: Number(row.total_tokens),
    today_prompt_tokens: Number(row.prompt_tokens),
    today_completion_tokens: Number(row.completion_tokens),
    today_errors: row.total_errors,
    // RPM/TPM 使用近 5 分钟窗口除以 5 ，比 1 分钟窗口更平滑、更少出现 0
    current_rpm: Math.round(row.r5_total / 5),
    current_tpm: Math.round(Number(row.r5_tokens) / 5),
    current_avg_latency_ms: roundOrNull(row.recent_avg_latency),
    today_avg_latency_ms: roundOrNull(row.today_avg_latency),
    today_avg_ttft_ms: roundOrNull(row.today_avg_ttft),
    today_avg_itl_ms: roundOrNull(row.today_avg_itl),
    current_error_rate: safeRate(row.r5_errors, row.r5_total),
    current_cache_hit_rate: safeRate(Number(row.r5_cached), Number(row.r5_prompt)),
    today_cost: Math.round(row.today_cost * 1_000_000) / 1_000_000,
  };
}
