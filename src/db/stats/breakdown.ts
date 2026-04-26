// src/db/stats/breakdown.ts — 分组占比统计查询

import { db } from '@/db/client';
import { buildDimensionFilterAliased, buildTimeFilter, itlExpr, latencyExpr, roundOrNull, ttftExpr } from './helpers';
import type { StatsBreakdown, StatsBreakdownGroupBy, StatsBreakdownItem, StatsQueryParams } from './types';

// ==================== 行类型 ====================

interface BreakdownRow {
  name: string;
  provider_name: string | null;
  provider_kind?: string | null;
  provider_model_id?: string | null;
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
  total_cost: number;
}

function mapBreakdownRow(row: BreakdownRow, providerNameOverride?: string | null): StatsBreakdownItem {
  return {
    name: row.name,
    provider_name: providerNameOverride === undefined ? row.provider_name : providerNameOverride,
    provider_kind: row.provider_kind === undefined ? null : row.provider_kind,
    provider_model_id: row.provider_model_id === undefined ? null : row.provider_model_id,
    request_count: row.request_count,
    total_tokens: Number(row.total_tokens),
    error_count: row.error_count,
    avg_latency_ms: roundOrNull(row.avg_latency_ms),
    p50_latency_ms: roundOrNull(row.p50_latency_ms),
    p90_latency_ms: roundOrNull(row.p90_latency_ms),
    p99_latency_ms: roundOrNull(row.p99_latency_ms),
    ttft_avg_ms: roundOrNull(row.ttft_avg_ms),
    itl_avg_ms: roundOrNull(row.itl_avg_ms),
    avg_completion_tokens: row.avg_completion_tokens === null ? null : Math.round(row.avg_completion_tokens),
    total_cost: Math.round(row.total_cost * 1_000_000) / 1_000_000,
  };
}

// ==================== 分组查询实现 ====================

/**
 * provider_model 分组
 *
 * 性能优化：
 * - total_tokens / avg_completion_tokens 直接读主表列，去掉 token 的 JSONB 提取
 * - provider_name 改用 LEFT JOIN 代替相关子查询（消灭 N+1）
 * - provider_model_id 改用 LEFT JOIN 代替相关子查询（消灭 N+1）
 * - timing 延迟计算仍需 JOIN details 表，保留
 */
async function breakdownByProviderModel(params: StatsQueryParams): Promise<StatsBreakdown> {
  const timeFilter = buildTimeFilter(params, 1);
  const dimFilter = buildDimensionFilterAliased(params.dimension, params.id, timeFilter.nextIdx, 'rl');

  const rlTimeClause = timeFilter.clause.replaceAll(/\bcreated_at\b/g, 'rl.created_at');
  const rlValues = [...timeFilter.values, ...dimFilter.values];

  const latExpr = latencyExpr('d');
  const ttftEx = ttftExpr('d');
  const itlEx = itlExpr('d', 'd');

  const sql = `
    SELECT
      COALESCE(mp.name, rl.provider_id::text, 'unknown') AS provider_name,
      MAX(rl.provider_kind) AS provider_kind,
      COALESCE(rl.routed_model::text, 'unknown') AS name,
      MAX(mpm.id) AS provider_model_id,
      COUNT(*)::int AS request_count,
      COALESCE(SUM(rl.total_tokens), 0)::bigint AS total_tokens,
      COUNT(*) FILTER (WHERE rl.status = 'error')::int AS error_count,
      AVG(${latExpr})::float AS avg_latency_ms,
      PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY ${latExpr})::float AS p50_latency_ms,
      PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY ${latExpr})::float AS p90_latency_ms,
      PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY ${latExpr})::float AS p99_latency_ms,
      AVG(${ttftEx})::float AS ttft_avg_ms,
      AVG(${itlEx})::float AS itl_avg_ms,
      AVG(rl.completion_tokens)::float AS avg_completion_tokens,
      COALESCE(SUM(rl.calculated_cost), 0.0)::float AS total_cost
    FROM request_logs rl
    LEFT JOIN request_logs_details d ON d.id = rl.id
    LEFT JOIN model_providers mp ON mp.id = rl.provider_id
    LEFT JOIN model_provider_models mpm
      ON mpm.provider_id = rl.provider_id AND mpm.name = rl.routed_model
    WHERE ${rlTimeClause}
    ${dimFilter.clause}
    GROUP BY rl.provider_id, rl.routed_model, mp.name
    ORDER BY request_count DESC
    LIMIT 50
  `;

  const result = await db.query<Record<string, unknown>>(sql, rlValues);
  return {
    group_by: 'provider_model',
    items: result.rows.map((row) => mapBreakdownRow(row as unknown as BreakdownRow)),
  };
}

/**
 * app 分组
 *
 * 性能优化：total_tokens 直接读主表列，仅 appName/appId 标识字段仍需 JOIN details
 */
async function breakdownByApp(params: StatsQueryParams): Promise<StatsBreakdown> {
  const timeFilter = buildTimeFilter(params, 1);
  const dimFilter = buildDimensionFilterAliased(params.dimension, params.id, timeFilter.nextIdx, 'r');
  const rlTimeClause = timeFilter.clause.replaceAll(/\bcreated_at\b/g, 'r.created_at');
  const allValues = [...timeFilter.values, ...dimFilter.values];

  const latExpr = latencyExpr('d');
  const ttftEx = ttftExpr('d');
  const itlEx = itlExpr('d', 'd');

  const sql = `
    SELECT
      COALESCE(d.gateway_context->>'appName', d.gateway_context->>'appId', 'unknown') AS name,
      NULL::text AS provider_name,
      COUNT(*)::int AS request_count,
      COALESCE(SUM(r.total_tokens), 0)::bigint AS total_tokens,
      COUNT(*) FILTER (WHERE r.status = 'error')::int AS error_count,
      AVG(${latExpr})::float AS avg_latency_ms,
      PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY ${latExpr})::float AS p50_latency_ms,
      PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY ${latExpr})::float AS p90_latency_ms,
      PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY ${latExpr})::float AS p99_latency_ms,
      AVG(${ttftEx})::float AS ttft_avg_ms,
      AVG(${itlEx})::float AS itl_avg_ms,
      AVG(r.completion_tokens)::float AS avg_completion_tokens,
      COALESCE(SUM(r.calculated_cost), 0.0)::float AS total_cost
    FROM request_logs r
    LEFT JOIN request_logs_details d ON d.id = r.id
    WHERE ${rlTimeClause}
    ${dimFilter.clause}
    GROUP BY d.gateway_context->>'appName', d.gateway_context->>'appId'
    ORDER BY request_count DESC
    LIMIT 50
  `;

  const result = await db.query<Record<string, unknown>>(sql, allValues);
  return {
    group_by: 'app',
    items: result.rows.map((row) => mapBreakdownRow(row as unknown as BreakdownRow, null)),
  };
}

/**
 * provider 分组
 *
 * 性能优化：
 * - total_tokens 直接读主表列
 * - provider_name 改用 LEFT JOIN 代替相关子查询
 */
async function breakdownByProvider(params: StatsQueryParams): Promise<StatsBreakdown> {
  const timeFilter = buildTimeFilter(params, 1);
  const dimFilter = buildDimensionFilterAliased(params.dimension, params.id, timeFilter.nextIdx, 'r');
  const rlTimeClause = timeFilter.clause.replaceAll(/\bcreated_at\b/g, 'r.created_at');
  const allValues = [...timeFilter.values, ...dimFilter.values];

  const latExpr = latencyExpr('d');
  const ttftEx = ttftExpr('d');
  const itlEx = itlExpr('d', 'd');

  const sql = `
    SELECT
      COALESCE(mp.name, r.provider_id::text, 'unknown') AS name,
      NULL::text AS provider_name,
      COUNT(*)::int AS request_count,
      COALESCE(SUM(r.total_tokens), 0)::bigint AS total_tokens,
      COUNT(*) FILTER (WHERE r.status = 'error')::int AS error_count,
      AVG(${latExpr})::float AS avg_latency_ms,
      PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY ${latExpr})::float AS p50_latency_ms,
      PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY ${latExpr})::float AS p90_latency_ms,
      PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY ${latExpr})::float AS p99_latency_ms,
      AVG(${ttftEx})::float AS ttft_avg_ms,
      AVG(${itlEx})::float AS itl_avg_ms,
      AVG(r.completion_tokens)::float AS avg_completion_tokens,
      COALESCE(SUM(r.calculated_cost), 0.0)::float AS total_cost
    FROM request_logs r
    LEFT JOIN request_logs_details d ON d.id = r.id
    LEFT JOIN model_providers mp ON mp.id = r.provider_id
    WHERE ${rlTimeClause}
    ${dimFilter.clause}
    GROUP BY r.provider_id, mp.name
    ORDER BY request_count DESC
    LIMIT 50
  `;

  const result = await db.query<Record<string, unknown>>(sql, allValues);
  return {
    group_by: 'provider',
    items: result.rows.map((row) => mapBreakdownRow(row as unknown as BreakdownRow, null)),
  };
}

/**
 * 通用分组：virtual_model, error_type, user_format
 *
 * 性能优化：total_tokens / avg_completion_tokens 改为直接读主表列
 */
async function breakdownGeneric(
  params: StatsQueryParams,
  groupBy: Extract<StatsBreakdownGroupBy, 'virtual_model' | 'error_type' | 'user_format'>,
): Promise<StatsBreakdown> {
  const timeFilter = buildTimeFilter(params, 1);
  const dimFilter = buildDimensionFilterAliased(params.dimension, params.id, timeFilter.nextIdx, 'r');
  const rlTimeClause = timeFilter.clause.replaceAll(/\bcreated_at\b/g, 'r.created_at');
  const allValues = [...timeFilter.values, ...dimFilter.values];

  // user_format 现在来自冷表 d.gateway_context；其他两列在热表 r 上
  const columnMap: Record<typeof groupBy, string> = {
    virtual_model: 'r.request_model',
    error_type: 'r.error_type',
    user_format: "d.gateway_context->>'userFormat'",
  };
  const col = columnMap[groupBy];

  const latExpr = latencyExpr('d');
  const ttftEx = ttftExpr('d');
  const itlEx = itlExpr('d', 'd');

  const sql = `
    SELECT
      COALESCE(${col}::text, 'unknown') AS name,
      NULL::text AS provider_name,
      COUNT(*)::int AS request_count,
      COALESCE(SUM(r.total_tokens), 0)::bigint AS total_tokens,
      COUNT(*) FILTER (WHERE r.status = 'error')::int AS error_count,
      AVG(${latExpr})::float AS avg_latency_ms,
      PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY ${latExpr})::float AS p50_latency_ms,
      PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY ${latExpr})::float AS p90_latency_ms,
      PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY ${latExpr})::float AS p99_latency_ms,
      AVG(${ttftEx})::float AS ttft_avg_ms,
      AVG(${itlEx})::float AS itl_avg_ms,
      AVG(r.completion_tokens)::float AS avg_completion_tokens,
      COALESCE(SUM(r.calculated_cost), 0.0)::float AS total_cost
    FROM request_logs r
    LEFT JOIN request_logs_details d ON d.id = r.id
    WHERE ${rlTimeClause}
    ${dimFilter.clause}
    GROUP BY ${col}
    ORDER BY request_count DESC
    LIMIT 50
  `;

  const result = await db.query<Record<string, unknown>>(sql, allValues);
  return {
    group_by: groupBy,
    items: result.rows.map((row) => mapBreakdownRow(row as unknown as BreakdownRow)),
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
    case 'provider_model': {
      return await breakdownByProviderModel(params);
    }
    case 'app': {
      return await breakdownByApp(params);
    }
    case 'provider': {
      return await breakdownByProvider(params);
    }
    case 'virtual_model':
    case 'error_type':
    case 'user_format': {
      return await breakdownGeneric(params, groupBy);
    }
  }
}
