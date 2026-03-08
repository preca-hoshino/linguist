// src/db/stats/today.ts — 今日实时统计查询

import { db } from '../client';
import { buildDimensionFilter, LATENCY_EXPR, roundOrNull, safeRate } from './helpers';
import type { StatsDimension, StatsToday } from './types';

/**
 * 获取今日实时统计（大数字卡片）
 * 同一次查询返回「今日累计」和「近期实时值」，前端轮询此端点刷新卡片
 */
export async function getStatsToday(dimension: StatsDimension, id?: string): Promise<StatsToday> {
  const dimFilter = buildDimensionFilter(dimension, id, 1);

  // 使用 CTE 同时计算今日累计 + 近 1 分钟 + 近 5 分钟
  const sql = `
    WITH today AS (
      SELECT
        COUNT(*)::int AS total_reqs,
        COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
        COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens,
        COUNT(*) FILTER (WHERE status = 'error')::int AS total_errors,
        AVG(${LATENCY_EXPR})::float AS today_avg_latency
      FROM request_logs
      WHERE created_at >= date_trunc('day', NOW())
      ${dimFilter.clause}
    ),
    recent_1m AS (
      SELECT
        COUNT(*)::int AS reqs,
        COALESCE(SUM(total_tokens), 0)::bigint AS tokens
      FROM request_logs
      WHERE created_at >= NOW() - INTERVAL '1 minute'
      ${dimFilter.clause}
    ),
    recent_5m AS (
      SELECT
        AVG(${LATENCY_EXPR})::float AS recent_avg_latency,
        COUNT(*) FILTER (WHERE status = 'error')::int AS errors,
        COUNT(*)::int AS total,
        COALESCE(SUM(cached_tokens), 0)::bigint AS cached,
        COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt,
        COALESCE(SUM(total_tokens), 0)::bigint AS tokens
      FROM request_logs
      WHERE created_at >= NOW() - INTERVAL '5 minutes'
      ${dimFilter.clause}
    )
    SELECT
      t.total_reqs, t.total_tokens, t.prompt_tokens, t.completion_tokens, t.total_errors,
      t.today_avg_latency,
      r1.reqs AS rpm_reqs, r1.tokens AS rpm_tokens,
      r5.recent_avg_latency, r5.errors AS r5_errors, r5.total AS r5_total,
      r5.cached AS r5_cached, r5.prompt AS r5_prompt, r5.tokens AS r5_tokens
    FROM today t, recent_1m r1, recent_5m r5
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
      current_error_rate: 0,
      current_cache_hit_rate: 0,
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
    current_error_rate: safeRate(row.r5_errors, row.r5_total),
    current_cache_hit_rate: safeRate(Number(row.r5_cached), Number(row.r5_prompt)),
  };
}
