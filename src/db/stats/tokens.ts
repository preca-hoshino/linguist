// src/db/stats/tokens.ts — Token 用量统计查询

import { db } from '@/db/client';
import { buildDimensionFilterAliased, buildTimeFilter } from './helpers';
import type { StatsQueryParams, StatsTokens } from './types';

/**
 * 获取 Token 用量分析数据
 *
 * 性能优化：
 * - 直接读取 request_logs 主表的 token 统计列（prompt_tokens 等），
 *   无需 JOIN request_logs_details，消除 JSONB 路径解析开销。
 * - PERCENTILE_CONT 排序也直接基于主表列，避免重复 JSONB 解析。
 */
export async function getStatsTokens(params: StatsQueryParams): Promise<StatsTokens> {
  const timeFilter = buildTimeFilter(params, 1);
  const timeClauseAliased = timeFilter.clause.replaceAll('created_at', 'r.created_at');
  const dimFilter = buildDimensionFilterAliased(params.dimension, params.id, timeFilter.nextIdx, 'r');
  const allValues = [...timeFilter.values, ...dimFilter.values];

  const sql = `
    SELECT
      COALESCE(SUM(r.prompt_tokens), 0)::bigint AS prompt_tokens,
      COALESCE(SUM(r.completion_tokens), 0)::bigint AS completion_tokens,
      COALESCE(SUM(r.reasoning_tokens), 0)::bigint AS reasoning_tokens,
      COALESCE(SUM(r.cached_tokens), 0)::bigint AS cached_tokens,
      AVG(r.prompt_tokens)::float AS avg_input,
      AVG(r.completion_tokens)::float AS avg_output,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY r.prompt_tokens)::float AS p95_input,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY r.completion_tokens)::float AS p95_output
    FROM request_logs r
    WHERE ${timeClauseAliased}
    AND r.status = 'completed'
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
