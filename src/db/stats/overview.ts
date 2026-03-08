// src/db/stats/overview.ts — 概览统计查询

import { db } from '../client';
import { createLogger, logColors } from '../../utils';
import { buildTimeFilter, buildDimensionFilter, getWindowMinutes, TTFT_EXPR } from './helpers';
import type { StatsQueryParams, StatsOverview } from './types';

const logger = createLogger('Stats', logColors.bold + logColors.blue);

/**
 * 获取概览统计数据
 */
export async function getStatsOverview(params: StatsQueryParams): Promise<StatsOverview> {
  const minutes = getWindowMinutes(params);
  const timeFilter = buildTimeFilter(params, 1);
  const dimFilter = buildDimensionFilter(params.dimension, params.id, timeFilter.nextIdx);
  const allValues = [...timeFilter.values, ...dimFilter.values];

  const sql = `
    SELECT
      COUNT(*)::int AS total_requests,
      COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt_tokens,
      COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens,
      COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
      COALESCE(SUM(cached_tokens), 0)::bigint AS cached_tokens,
      COALESCE(SUM(reasoning_tokens), 0)::bigint AS reasoning_tokens,
      COUNT(*) FILTER (WHERE status = 'error')::int AS error_count,
      COUNT(*) FILTER (WHERE error_type = 'rate_limit')::int AS rate_limit_error_count,
      COUNT(*) FILTER (WHERE error_type = 'timeout')::int AS timeout_error_count,
      AVG(
        CASE WHEN timing->>'end' IS NOT NULL AND timing->>'start' IS NOT NULL
        THEN (timing->>'end')::float - (timing->>'start')::float
        END
      )::float AS avg_latency_ms,
      PERCENTILE_CONT(0.95) WITHIN GROUP (
        ORDER BY CASE WHEN timing->>'end' IS NOT NULL AND timing->>'start' IS NOT NULL
        THEN (timing->>'end')::float - (timing->>'start')::float END
      )::float AS p95_latency_ms,
      AVG(
        CASE WHEN timing->>'providerEnd' IS NOT NULL AND timing->>'providerStart' IS NOT NULL
        THEN (timing->>'providerEnd')::float - (timing->>'providerStart')::float
        END
      )::float AS avg_provider_latency_ms,
      AVG(
        CASE
          WHEN timing->>'start' IS NOT NULL
            AND timing->>'providerStart' IS NOT NULL
            AND timing->>'providerEnd' IS NOT NULL
            AND timing->>'end' IS NOT NULL
            AND ((timing->>'providerEnd')::float - (timing->>'providerStart')::float) > 0
          THEN (
            ((timing->>'providerStart')::float - (timing->>'start')::float)
            + ((timing->>'end')::float - (timing->>'providerEnd')::float)
          ) / ((timing->>'providerEnd')::float - (timing->>'providerStart')::float) * 100
        END
      )::float AS gateway_overhead_percent,
      AVG(prompt_tokens)::float AS avg_input_tokens,
      AVG(completion_tokens)::float AS avg_output_tokens,
      AVG(${TTFT_EXPR})::float AS ttft_avg_ms
    FROM request_logs
    WHERE ${timeFilter.clause}
    ${dimFilter.clause}
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
    gateway_overhead_percent: number | null;
    avg_input_tokens: number | null;
    avg_output_tokens: number | null;
    ttft_avg_ms: number | null;
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
      gateway_overhead_percent: null,
      avg_input_tokens_per_req: null,
      avg_output_tokens_per_req: null,
      ttft_avg_ms: null,
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
    cache_hit_rate: promptTokens > 0 ? Math.round((cachedTokens / promptTokens) * 10000) / 10000 : 0,
    error_count: row.error_count,
    error_rate: totalReqs > 0 ? Math.round((row.error_count / totalReqs) * 10000) / 10000 : 0,
    rate_limit_error_count: row.rate_limit_error_count,
    rate_limit_error_rate: totalReqs > 0 ? Math.round((row.rate_limit_error_count / totalReqs) * 10000) / 10000 : 0,
    timeout_error_count: row.timeout_error_count,
    timeout_error_rate: totalReqs > 0 ? Math.round((row.timeout_error_count / totalReqs) * 10000) / 10000 : 0,
    avg_latency_ms: row.avg_latency_ms !== null ? Math.round(row.avg_latency_ms) : null,
    p95_latency_ms: row.p95_latency_ms !== null ? Math.round(row.p95_latency_ms) : null,
    avg_provider_latency_ms: row.avg_provider_latency_ms !== null ? Math.round(row.avg_provider_latency_ms) : null,
    gateway_overhead_percent:
      row.gateway_overhead_percent !== null ? Math.round(row.gateway_overhead_percent * 10) / 10 : null,
    avg_input_tokens_per_req: row.avg_input_tokens !== null ? Math.round(row.avg_input_tokens) : null,
    avg_output_tokens_per_req: row.avg_output_tokens !== null ? Math.round(row.avg_output_tokens) : null,
    ttft_avg_ms: row.ttft_avg_ms !== null ? Math.round(row.ttft_avg_ms) : null,
  };
}
