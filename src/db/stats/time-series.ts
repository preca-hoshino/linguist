// src/db/stats/time-series.ts — 时序统计查询

import { db } from '@/db/client';
import {
  autoInterval,
  autoIntervalForDates,
  buildBucketExpr,
  buildDimensionFilterAliased,
  floorToInterval,
  itlExpr,
  latencyExpr,
  rangeToMinutes,
  roundOrNull,
  roundRate,
  safeRate,
  ttftExpr,
} from './helpers';
import type { StatsInterval, StatsQueryParams, TimeSeriesPoint, TimeSeriesResult } from './types';

/**
 * 获取时序统计数据
 *
 * 使用 generate_series 在 SQL 层填充空 bucket，保证返回固定数量端点。
 * 前端无需再做 alignTimeSeries 处理。
 */
export async function getStatsTimeSeries(
  params: StatsQueryParams,
  interval?: StatsInterval,
): Promise<TimeSeriesResult> {
  const selectedInterval =
    interval ??
    (params.from !== undefined && params.to !== undefined
      ? autoIntervalForDates(new Date(params.from), new Date(params.to))
      : autoInterval(params.range ?? '1h'));

  // 计算精确的时间范围
  let rangeEnd: Date;
  let rawStart: Date;
  if (params.from !== undefined && params.to !== undefined) {
    rawStart = new Date(params.from);
    rangeEnd = new Date(params.to);
  } else {
    rangeEnd = new Date();
    rawStart = new Date(rangeEnd.getTime() - rangeToMinutes(params.range ?? '1h') * 60_000);
  }
  // 将起点对齐到粒度边界，确保 generate_series 与 bucket_expr 精确匹配
  const seriesStart = floorToInterval(rawStart, selectedInterval);

  const { expr: bucketExpr, minutes: bMinutes, pgInterval } = buildBucketExpr(selectedInterval);
  const bucketExprAliased = bucketExpr.replaceAll('created_at', 'r.created_at');

  // $1 = seriesStart, $2 = rangeEnd, $3 = pgInterval, $4+ = 维度过滤
  const dimFilterAliased = buildDimensionFilterAliased(params.dimension, params.id, 4, 'r');
  const allValues: unknown[] = [
    seriesStart.toISOString(),
    rangeEnd.toISOString(),
    pgInterval,
    ...dimFilterAliased.values,
  ];

  const L_EXPR = latencyExpr('d');
  const T_EXPR = ttftExpr('d');
  const I_EXPR = itlExpr('d', 'd');

  // generate_series 生成完整时间槽；agg CTE 聚合实际数据；LEFT JOIN 填充空 bucket 为 0
  const sql = `
    WITH buckets AS (
      SELECT gs AS bucket
      FROM generate_series($1::timestamptz, $2::timestamptz, $3::interval) gs
    ),
    agg AS (
      SELECT
        ${bucketExprAliased} AS bucket,
        COUNT(*)::int                                                        AS requests,
        COALESCE(SUM(r.prompt_tokens), 0)::bigint                            AS sum_prompt_tokens,
        COALESCE(SUM(r.completion_tokens), 0)::bigint                        AS sum_completion_tokens,
        COALESCE(SUM(r.total_tokens), 0)::bigint                             AS sum_total_tokens,
        COALESCE(SUM(r.cached_tokens), 0)::bigint                            AS sum_cached_tokens,
        COALESCE(SUM(r.calculated_cost), 0.0)::float                          AS sum_calculated_cost,
        COUNT(*) FILTER (WHERE r.status = 'error')::int                       AS error_count,
        COUNT(*) FILTER (WHERE r.error_type = 'timeout')::int                 AS timeout_count,
        COUNT(*) FILTER (WHERE r.error_type = 'rate_limit')::int              AS rate_limit_count,
        AVG(${L_EXPR})::float                                         AS avg_latency_ms,
        PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY ${L_EXPR})::float AS p50_latency_ms,
        PERCENTILE_CONT(0.9)  WITHIN GROUP (ORDER BY ${L_EXPR})::float AS p90_latency_ms,
        PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY ${L_EXPR})::float AS p99_latency_ms,
        AVG(${T_EXPR})::float                                            AS ttft_avg_ms,
        PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY ${T_EXPR})::float  AS ttft_p50_ms,
        PERCENTILE_CONT(0.9)  WITHIN GROUP (ORDER BY ${T_EXPR})::float  AS ttft_p90_ms,
        PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY ${T_EXPR})::float  AS ttft_p99_ms,
        AVG(${I_EXPR})::float                                             AS itl_avg_ms,
        PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY ${I_EXPR})::float   AS itl_p50_ms,
        PERCENTILE_CONT(0.9)  WITHIN GROUP (ORDER BY ${I_EXPR})::float   AS itl_p90_ms,
        PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY ${I_EXPR})::float   AS itl_p99_ms
      FROM request_logs r
      LEFT JOIN request_logs_details d ON r.id = d.id
      WHERE r.created_at >= $1 AND r.created_at < $2
      ${dimFilterAliased.clause}
      GROUP BY bucket
    )
    SELECT
      b.bucket::text,
      COALESCE(a.requests, 0)              AS requests,
      COALESCE(a.sum_prompt_tokens, 0)     AS sum_prompt_tokens,
      COALESCE(a.sum_completion_tokens, 0) AS sum_completion_tokens,
      COALESCE(a.sum_total_tokens, 0)      AS sum_total_tokens,
      COALESCE(a.sum_cached_tokens, 0)     AS sum_cached_tokens,
      COALESCE(a.sum_calculated_cost, 0.0) AS sum_calculated_cost,
      COALESCE(a.error_count, 0)           AS error_count,
      COALESCE(a.timeout_count, 0)         AS timeout_count,
      COALESCE(a.rate_limit_count, 0)      AS rate_limit_count,
      a.avg_latency_ms,
      a.p50_latency_ms,
      a.p90_latency_ms,
      a.p99_latency_ms,
      a.ttft_avg_ms,
      a.ttft_p50_ms,
      a.ttft_p90_ms,
      a.ttft_p99_ms,
      a.itl_avg_ms,
      a.itl_p50_ms,
      a.itl_p90_ms,
      a.itl_p99_ms
    FROM buckets b
    LEFT JOIN agg a ON b.bucket = a.bucket
    ORDER BY b.bucket
  `;

  const result = await db.query<{
    bucket: string;
    requests: number;
    sum_prompt_tokens: string;
    sum_completion_tokens: string;
    sum_total_tokens: string;
    sum_cached_tokens: string;
    sum_calculated_cost: number;
    error_count: number;
    timeout_count: number;
    rate_limit_count: number;
    avg_latency_ms: number | null;
    p50_latency_ms: number | null;
    p90_latency_ms: number | null;
    p99_latency_ms: number | null;
    ttft_avg_ms: number | null;
    ttft_p50_ms: number | null;
    ttft_p90_ms: number | null;
    ttft_p99_ms: number | null;
    itl_avg_ms: number | null;
    itl_p50_ms: number | null;
    itl_p90_ms: number | null;
    itl_p99_ms: number | null;
  }>(sql, allValues);

  const series: TimeSeriesPoint[] = result.rows.map((row) => {
    const reqs = row.requests;
    const pTokens = Number(row.sum_prompt_tokens);
    const cTokens = Number(row.sum_completion_tokens);
    const tTokens = Number(row.sum_total_tokens);
    const cachedTokens = Number(row.sum_cached_tokens);
    return {
      time: new Date(row.bucket).toISOString(),
      requests: reqs,
      rpm: roundRate(reqs / bMinutes),
      prompt_tokens: pTokens,
      completion_tokens: cTokens,
      total_tokens: tTokens,
      cached_tokens: cachedTokens,
      tpm: roundRate(tTokens / bMinutes),
      error_count: row.error_count,
      error_rate: safeRate(row.error_count, reqs),
      timeout_count: row.timeout_count,
      rate_limit_count: row.rate_limit_count,
      avg_latency_ms: roundOrNull(row.avg_latency_ms),
      p50_latency_ms: roundOrNull(row.p50_latency_ms),
      p90_latency_ms: roundOrNull(row.p90_latency_ms),
      p99_latency_ms: roundOrNull(row.p99_latency_ms),
      ttft_avg_ms: roundOrNull(row.ttft_avg_ms),
      ttft_p50_ms: roundOrNull(row.ttft_p50_ms),
      ttft_p90_ms: roundOrNull(row.ttft_p90_ms),
      ttft_p99_ms: roundOrNull(row.ttft_p99_ms),
      itl_avg_ms: roundOrNull(row.itl_avg_ms),
      itl_p50_ms: roundOrNull(row.itl_p50_ms),
      itl_p90_ms: roundOrNull(row.itl_p90_ms),
      itl_p99_ms: roundOrNull(row.itl_p99_ms),
      cache_hit_rate: safeRate(cachedTokens, pTokens),
      cost: Math.round(row.sum_calculated_cost * 1_000_000) / 1_000_000,
    };
  });

  return { interval: selectedInterval, series };
}
