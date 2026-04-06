// src/db/stats/tokens.ts — Token 用量统计查询

import { db } from '@/db/client';
import { buildDimensionFilter, buildTimeFilter } from './helpers';
import type { StatsQueryParams, StatsTokens } from './types';

/**
 * 获取 Token 用量分析数据
 */
export async function getStatsTokens(params: StatsQueryParams): Promise<StatsTokens> {
  const timeFilter = buildTimeFilter(params, 1);
  const dimFilter = buildDimensionFilter(params.dimension, params.id, timeFilter.nextIdx);
  const allValues = [...timeFilter.values, ...dimFilter.values];

  const sql = `
    SELECT
      COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt_tokens,
      COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens,
      COALESCE(SUM(reasoning_tokens), 0)::bigint AS reasoning_tokens,
      COALESCE(SUM(cached_tokens), 0)::bigint AS cached_tokens,
      AVG(prompt_tokens)::float AS avg_input,
      AVG(completion_tokens)::float AS avg_output,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY prompt_tokens)::float AS p95_input,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY completion_tokens)::float AS p95_output
    FROM request_logs
    WHERE ${timeFilter.clause}
    AND status = 'completed'
    ${dimFilter.clause}
  `;

  const result = await db.query<{
    prompt_tokens: string;
    completion_tokens: string;
    reasoning_tokens: string;
    cached_tokens: string;
    avg_input: number | null;
    avg_output: number | null;
    p95_input: number | null;
    p95_output: number | null;
  }>(sql, allValues);

  const row = result.rows[0];
  if (!row) {
    return {
      prompt_tokens: 0,
      completion_tokens: 0,
      reasoning_tokens: 0,
      cached_tokens: 0,
      cache_hit_rate: 0,
      avg_input_tokens_per_req: null,
      avg_output_tokens_per_req: null,
      p95_input_tokens_per_req: null,
      p95_output_tokens_per_req: null,
    };
  }
  const promptTokens = Number(row.prompt_tokens);
  const cachedTokens = Number(row.cached_tokens);

  return {
    prompt_tokens: promptTokens,
    completion_tokens: Number(row.completion_tokens),
    reasoning_tokens: Number(row.reasoning_tokens),
    cached_tokens: cachedTokens,
    cache_hit_rate: promptTokens > 0 ? Math.round((cachedTokens / promptTokens) * 10_000) / 10_000 : 0,
    avg_input_tokens_per_req: row.avg_input === null ? null : Math.round(row.avg_input),
    avg_output_tokens_per_req: row.avg_output === null ? null : Math.round(row.avg_output),
    p95_input_tokens_per_req: row.p95_input === null ? null : Math.round(row.p95_input),
    p95_output_tokens_per_req: row.p95_output === null ? null : Math.round(row.p95_output),
  };
}
