// src/db/stats/breakdown.ts — 分组占比统计查询

import { db } from '../client';
import {
  buildTimeFilter,
  buildDimensionFilter,
  buildDimensionFilterAliased,
  latencyExpr,
  ttftExpr,
  itlExpr,
  LATENCY_EXPR,
  TTFT_EXPR,
  ITL_EXPR,
  roundOrNull,
} from './helpers';
import type { StatsQueryParams, StatsBreakdown, StatsBreakdownGroupBy, StatsBreakdownItem } from './types';

// ==================== 行类型 ====================

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
type BreakdownRow = {
  name: string;
  provider_name: string | null;
  request_count: number;
  total_tokens: string;
  error_count: number;
  avg_latency_ms: number | null;
  p50_latency_ms: number | null;
  p90_latency_ms: number | null;
  p99_latency_ms: number | null;
  ttft_avg_ms: number | null;
  itl_avg_ms: number | null;
  avg_completion_tokens: number | null;
};

function mapBreakdownRow(row: BreakdownRow, providerNameOverride?: string | null): StatsBreakdownItem {
  return {
    name: row.name,
    provider_name: providerNameOverride !== undefined ? providerNameOverride : row.provider_name,
    request_count: row.request_count,
    total_tokens: Number(row.total_tokens),
    error_count: row.error_count,
    avg_latency_ms: roundOrNull(row.avg_latency_ms),
    p50_latency_ms: roundOrNull(row.p50_latency_ms),
    p90_latency_ms: roundOrNull(row.p90_latency_ms),
    p99_latency_ms: roundOrNull(row.p99_latency_ms),
    ttft_avg_ms: roundOrNull(row.ttft_avg_ms),
    itl_avg_ms: roundOrNull(row.itl_avg_ms),
    avg_completion_tokens: row.avg_completion_tokens !== null ? Math.round(row.avg_completion_tokens) : null,
  };
}

// ==================== 分组查询实现 ====================

/**
 * provider_model 分组：JOIN providers 获取提供商名称
 * 使用带别名的延迟表达式，避免 regex 列名替换
 */
async function breakdownByProviderModel(params: StatsQueryParams): Promise<StatsBreakdown> {
  // 时间过滤：直接使用带 rl. 前缀的过滤子句
  const timeFilter = buildTimeFilter(params, 1);
  const dimFilter = buildDimensionFilterAliased(params.dimension, params.id, timeFilter.nextIdx, 'rl');

  // 重新构造完整参数（时间过滤中的 clause 已用无前缀列名，但 rl 别名查询需要带前缀）
  const rlTimeClause = timeFilter.clause.replace(/\bcreated_at\b/g, 'rl.created_at');
  const rlValues = [...timeFilter.values, ...dimFilter.values];

  const latExpr = latencyExpr('rl');
  const ttftEx = ttftExpr('rl');

  const sql = `
    SELECT
      COALESCE((SELECT name FROM providers WHERE id = rl.provider_id), rl.provider_id::text, 'unknown') AS provider_name,
      COALESCE(rl.routed_model::text, 'unknown') AS name,
      COUNT(*)::int AS request_count,
      COALESCE(SUM(rl.total_tokens), 0)::bigint AS total_tokens,
      COUNT(*) FILTER (WHERE rl.status = 'error')::int AS error_count,
      AVG(${latExpr})::float AS avg_latency_ms,
      PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY ${latExpr})::float AS p50_latency_ms,
      PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY ${latExpr})::float AS p90_latency_ms,
      PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY ${latExpr})::float AS p99_latency_ms,
      AVG(${ttftEx})::float AS ttft_avg_ms,
      AVG(${itlExpr('rl')})::float AS itl_avg_ms,
      AVG(rl.completion_tokens)::float AS avg_completion_tokens
    FROM request_logs rl
    WHERE ${rlTimeClause}
    ${dimFilter.clause}
    GROUP BY rl.provider_id, rl.routed_model
    ORDER BY request_count DESC
    LIMIT 50
  `;

  const result = await db.query<BreakdownRow>(sql, rlValues);
  return {
    group_by: 'provider_model',
    items: result.rows.map((row) => mapBreakdownRow(row)),
  };
}

/**
 * api_key 分组：LEFT JOIN api_keys 表获取名称，避免只展示前缀
 */
async function breakdownByApiKey(params: StatsQueryParams): Promise<StatsBreakdown> {
  const timeFilter = buildTimeFilter(params, 1);
  const dimFilter = buildDimensionFilterAliased(params.dimension, params.id, timeFilter.nextIdx, 'rl');

  const rlTimeClause = timeFilter.clause.replace(/\bcreated_at\b/g, 'rl.created_at');
  const rlValues = [...timeFilter.values, ...dimFilter.values];

  const latExpr = latencyExpr('rl');
  const ttftEx = ttftExpr('rl');

  const sql = `
    SELECT
      COALESCE(MAX(ak.name), rl.api_key_prefix, 'unknown') AS name,
      NULL::text AS provider_name,
      COUNT(*)::int AS request_count,
      COALESCE(SUM(rl.total_tokens), 0)::bigint AS total_tokens,
      COUNT(*) FILTER (WHERE rl.status = 'error')::int AS error_count,
      AVG(${latExpr})::float AS avg_latency_ms,
      PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY ${latExpr})::float AS p50_latency_ms,
      PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY ${latExpr})::float AS p90_latency_ms,
      PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY ${latExpr})::float AS p99_latency_ms,
      AVG(${ttftEx})::float AS ttft_avg_ms,
      AVG(${itlExpr('rl')})::float AS itl_avg_ms,
      AVG(rl.completion_tokens)::float AS avg_completion_tokens
    FROM request_logs rl
    LEFT JOIN api_keys ak ON ak.key_prefix = rl.api_key_prefix
    WHERE ${rlTimeClause}
    ${dimFilter.clause}
    GROUP BY rl.api_key_prefix
    ORDER BY request_count DESC
    LIMIT 50
  `;

  const result = await db.query<BreakdownRow>(sql, rlValues);
  return {
    group_by: 'api_key',
    items: result.rows.map((row) => mapBreakdownRow(row, null)),
  };
}

/**
 * provider 分组：JOIN providers 表获取真实名称
 */
async function breakdownByProvider(params: StatsQueryParams): Promise<StatsBreakdown> {
  const timeFilter = buildTimeFilter(params, 1);
  const dimFilter = buildDimensionFilter(params.dimension, params.id, timeFilter.nextIdx);
  const allValues = [...timeFilter.values, ...dimFilter.values];

  const sql = `
    SELECT
      COALESCE((SELECT name FROM providers WHERE id = provider_id), provider_id::text, 'unknown') AS name,
      NULL::text AS provider_name,
      COUNT(*)::int AS request_count,
      COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
      COUNT(*) FILTER (WHERE status = 'error')::int AS error_count,
      AVG(${LATENCY_EXPR})::float AS avg_latency_ms,
      PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY ${LATENCY_EXPR})::float AS p50_latency_ms,
      PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY ${LATENCY_EXPR})::float AS p90_latency_ms,
      PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY ${LATENCY_EXPR})::float AS p99_latency_ms,
      AVG(${TTFT_EXPR})::float AS ttft_avg_ms,
      AVG(${ITL_EXPR})::float AS itl_avg_ms,
      AVG(completion_tokens)::float AS avg_completion_tokens
    FROM request_logs
    WHERE ${timeFilter.clause}
    ${dimFilter.clause}
    GROUP BY provider_id
    ORDER BY request_count DESC
    LIMIT 50
  `;

  const result = await db.query<BreakdownRow>(sql, allValues);
  return {
    group_by: 'provider',
    items: result.rows.map((row) => mapBreakdownRow(row, null)),
  };
}

/**
 * 通用分组：virtual_model, error_type
 */
async function breakdownGeneric(
  params: StatsQueryParams,
  groupBy: Extract<StatsBreakdownGroupBy, 'virtual_model' | 'error_type'>,
): Promise<StatsBreakdown> {
  const timeFilter = buildTimeFilter(params, 1);
  const dimFilter = buildDimensionFilter(params.dimension, params.id, timeFilter.nextIdx);
  const allValues = [...timeFilter.values, ...dimFilter.values];

  const columnMap: Record<typeof groupBy, string> = {
    virtual_model: 'request_model',
    error_type: 'error_type',
  };
  const col = columnMap[groupBy];

  const sql = `
    SELECT
      COALESCE(${col}::text, 'unknown') AS name,
      NULL::text AS provider_name,
      COUNT(*)::int AS request_count,
      COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
      COUNT(*) FILTER (WHERE status = 'error')::int AS error_count,
      AVG(${LATENCY_EXPR})::float AS avg_latency_ms,
      PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY ${LATENCY_EXPR})::float AS p50_latency_ms,
      PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY ${LATENCY_EXPR})::float AS p90_latency_ms,
      PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY ${LATENCY_EXPR})::float AS p99_latency_ms,
      AVG(${TTFT_EXPR})::float AS ttft_avg_ms,
      AVG(${ITL_EXPR})::float AS itl_avg_ms,
      AVG(completion_tokens)::float AS avg_completion_tokens
    FROM request_logs
    WHERE ${timeFilter.clause}
    ${dimFilter.clause}
    GROUP BY ${col}
    ORDER BY request_count DESC
    LIMIT 50
  `;

  const result = await db.query<BreakdownRow>(sql, allValues);
  return {
    group_by: groupBy,
    items: result.rows.map((row) => mapBreakdownRow(row)),
  };
}

// ==================== 公共入口 ====================

/**
 * 获取分组占比数据（环形图 / 饼图）
 * group_by 指定分组字段，dimension + id 作为可选过滤条件
 */
export async function getStatsBreakdown(
  params: StatsQueryParams,
  groupBy: StatsBreakdownGroupBy,
): Promise<StatsBreakdown> {
  switch (groupBy) {
    case 'provider_model':
      return await breakdownByProviderModel(params);
    case 'api_key':
      return await breakdownByApiKey(params);
    case 'provider':
      return await breakdownByProvider(params);
    case 'virtual_model':
      return await breakdownGeneric(params, groupBy);
    case 'error_type':
      return await breakdownGeneric(params, groupBy);
  }
}
