// src/db/stats/errors.ts — 错误分析统计查询

import { db } from '../client';
import { buildTimeFilter, buildDimensionFilter } from './helpers';
import type { StatsQueryParams, StatsErrors } from './types';
import type { ErrorType } from '../request-logs/types';

/**
 * 获取错误分析数据
 * 使用单个 CTE 查询替代多次独立查询（仅扫描一次表），样本查询单独执行
 */
export async function getStatsErrors(params: StatsQueryParams): Promise<StatsErrors> {
  const timeFilter = buildTimeFilter(params, 1);
  const dimFilter = buildDimensionFilter(params.dimension, params.id, timeFilter.nextIdx);
  const allValues = [...timeFilter.values, ...dimFilter.values];

  // 单次 CTE 扫描：同时计算 total/by_type/by_code
  const aggSql = `
    WITH base AS (
      SELECT status, error_type, error_code
      FROM request_logs
      WHERE ${timeFilter.clause}
      ${dimFilter.clause}
    )
    SELECT
      (SELECT COUNT(*)::int FROM base)                              AS total_requests,
      (SELECT COUNT(*)::int FROM base WHERE status = 'error')       AS total_errors,
      (
        SELECT json_object_agg(et, cnt)
        FROM (
          SELECT COALESCE(error_type, 'unknown') AS et, COUNT(*)::int AS cnt
          FROM base WHERE status = 'error'
          GROUP BY error_type
        ) t
      )                                                             AS by_type,
      (
        SELECT json_object_agg(ec, cnt)
        FROM (
          SELECT COALESCE(error_code, 'unknown') AS ec, COUNT(*)::int AS cnt
          FROM base WHERE status = 'error'
          GROUP BY error_code
          ORDER BY cnt DESC
          LIMIT 20
        ) t
      )                                                             AS by_code
  `;

  const aggResult = await db.query<{
    total_requests: number;
    total_errors: number;
    by_type: Record<string, number> | null;
    by_code: Record<string, number> | null;
  }>(aggSql, allValues);

  const aggRow = aggResult.rows[0];
  const totalRequests = aggRow?.total_requests ?? 0;
  const totalErrors = aggRow?.total_errors ?? 0;
  const byType: Record<string, number> = aggRow?.by_type ?? {};
  const byCode: Record<string, number> = aggRow?.by_code ?? {};

  // 最近错误样本（独立查询，需要额外列）
  const sampleSql = `
    SELECT id, error_type, error_code, error_message, provider_kind, request_model, created_at
    FROM request_logs
    WHERE status = 'error' AND ${timeFilter.clause}
    ${dimFilter.clause}
    ORDER BY created_at DESC
    LIMIT 10
  `;
  const sampleResult = await db.query<{
    id: string;
    error_type: ErrorType | null;
    error_code: string | null;
    error_message: string | null;
    provider_kind: string | null;
    request_model: string | null;
    created_at: string;
  }>(sampleSql, allValues);

  return {
    total_errors: totalErrors,
    error_rate: totalRequests > 0 ? Math.round((totalErrors / totalRequests) * 10000) / 10000 : 0,
    by_type: byType,
    by_code: byCode,
    recent_samples: sampleResult.rows,
  };
}
