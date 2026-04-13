// src/db/mcp-logs/stats.ts — MCP 日志统计聚合查询

import { db } from '@/db/client';

// ── 时间范围支持 ──────────────────────────────────────────────────────────────

export type McpStatsRange = '15m' | '1h' | '6h' | '24h' | '7d' | '14d' | '30d';
export type McpStatsInterval = '1m' | '5m' | '10m' | '15m' | '1h' | '6h' | '1d';
export type McpStatsDimension = 'global' | 'mcp_provider' | 'virtual_mcp';

export interface McpStatsQueryParams {
  dimension: McpStatsDimension;
  id?: string | undefined;
  range?: McpStatsRange | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

function getWindowMinutes(params: McpStatsQueryParams): number {
  if (params.from !== undefined && params.to !== undefined) {
    const ms = new Date(params.to).getTime() - new Date(params.from).getTime();
    return Math.max(ms / 60_000, 1);
  }
  const map: Record<McpStatsRange, number> = {
    '15m': 15,
    '1h': 60,
    '6h': 360,
    '24h': 1440,
    '7d': 10080,
    '14d': 20160,
    '30d': 43200,
  };
  return map[params.range ?? '1h'];
}

function buildTimeClause(
  params: McpStatsQueryParams,
  startIdx: number,
): { clause: string; values: unknown[]; nextIdx: number } {
  if (params.from !== undefined && params.to !== undefined) {
    return {
      clause: `created_at >= $${String(startIdx)} AND created_at < $${String(startIdx + 1)}`,
      values: [params.from, params.to],
      nextIdx: startIdx + 2,
    };
  }
  const rangeMap: Record<McpStatsRange, string> = {
    '15m': '15 minutes',
    '1h': '1 hour',
    '6h': '6 hours',
    '24h': '24 hours',
    '7d': '7 days',
    '14d': '14 days',
    '30d': '30 days',
  };
  const interval = rangeMap[params.range ?? '1h'];
  return {
    clause: `created_at >= NOW() - INTERVAL '${interval}'`,
    values: [],
    nextIdx: startIdx,
  };
}

function buildDimClause(
  params: McpStatsQueryParams,
  startIdx: number,
): { clause: string; values: unknown[]; nextIdx: number } {
  if (params.dimension === 'mcp_provider' && params.id !== undefined) {
    return { clause: `AND mcp_provider_id = $${String(startIdx)}`, values: [params.id], nextIdx: startIdx + 1 };
  }
  if (params.dimension === 'virtual_mcp' && params.id !== undefined) {
    return { clause: `AND virtual_mcp_id = $${String(startIdx)}`, values: [params.id], nextIdx: startIdx + 1 };
  }
  return { clause: '', values: [], nextIdx: startIdx };
}

// ── 概览统计 ──────────────────────────────────────────────────────────────────

export interface McpStatsOverview {
  total_requests: number;
  rpm: number;
  error_count: number;
  error_rate: number;
  avg_duration_ms: number | null;
  p95_duration_ms: number | null;
}

export async function getMcpStatsOverview(params: McpStatsQueryParams): Promise<McpStatsOverview> {
  const minutes = getWindowMinutes(params);
  const timePart = buildTimeClause(params, 1);
  const dimPart = buildDimClause(params, timePart.nextIdx);
  const values = [...timePart.values, ...dimPart.values];

  const sql = `
    SELECT
      COUNT(*)::int                                               AS total_requests,
      COUNT(*) FILTER (WHERE error IS NOT NULL)::int             AS error_count,
      PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY duration_ms)  AS avg_duration_ms,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)  AS p95_duration_ms
    FROM mcp_logs
    WHERE ${timePart.clause}
    ${dimPart.clause}
  `;

  const result = await db.query<{
    total_requests: number;
    error_count: number;
    avg_duration_ms: number | null;
    p95_duration_ms: number | null;
  }>(sql, values);

  const row = result.rows[0];
  if (!row) {
    return { total_requests: 0, rpm: 0, error_count: 0, error_rate: 0, avg_duration_ms: null, p95_duration_ms: null };
  }

  const total = row.total_requests;
  return {
    total_requests: total,
    rpm: total > 0 ? Math.round((total / minutes) * 100) / 100 : 0,
    error_count: row.error_count,
    error_rate: total > 0 ? Math.round((row.error_count / total) * 10_000) / 10_000 : 0,
    avg_duration_ms: row.avg_duration_ms === null ? null : Math.round(row.avg_duration_ms),
    p95_duration_ms: row.p95_duration_ms === null ? null : Math.round(row.p95_duration_ms),
  };
}

// ── 时序数据 ──────────────────────────────────────────────────────────────────

export interface McpStatsTimeSeriesPoint {
  ts: string;
  requests: number;
  errors: number;
  avg_duration_ms: number | null;
}

function resolveInterval(params: McpStatsQueryParams, override?: McpStatsInterval): string {
  if (override !== undefined) {
    const map: Record<McpStatsInterval, string> = {
      '1m': '1 minute',
      '5m': '5 minutes',
      '10m': '10 minutes',
      '15m': '15 minutes',
      '1h': '1 hour',
      '6h': '6 hours',
      '1d': '1 day',
    };
    return map[override];
  }
  const autoMap: Record<McpStatsRange, string> = {
    '15m': '1 minute',
    '1h': '5 minutes',
    '6h': '15 minutes',
    '24h': '1 hour',
    '7d': '6 hours',
    '14d': '6 hours',
    '30d': '1 day',
  };
  return autoMap[params.range ?? '1h'];
}

export async function getMcpStatsTimeSeries(
  params: McpStatsQueryParams,
  interval?: McpStatsInterval,
): Promise<McpStatsTimeSeriesPoint[]> {
  const intervalStr = resolveInterval(params, interval);
  const timePart = buildTimeClause(params, 1);
  const dimPart = buildDimClause(params, timePart.nextIdx);
  const values = [...timePart.values, ...dimPart.values];

  const sql = `
    SELECT
      date_trunc('${intervalStr.replace(' ', '')}', created_at) AS ts,
      COUNT(*)::int                                              AS requests,
      COUNT(*) FILTER (WHERE error IS NOT NULL)::int             AS errors,
      AVG(duration_ms)                                           AS avg_duration_ms
    FROM mcp_logs
    WHERE ${timePart.clause}
    ${dimPart.clause}
    GROUP BY 1
    ORDER BY 1
  `;

  const result = await db.query<{
    ts: string;
    requests: number;
    errors: number;
    avg_duration_ms: number | null;
  }>(sql, values);

  return result.rows.map((r) => ({
    ts: r.ts,
    requests: r.requests,
    errors: r.errors,
    avg_duration_ms: r.avg_duration_ms === null ? null : Math.round(r.avg_duration_ms),
  }));
}

// ── 方法分布统计 ─────────────────────────────────────────────────────────────

export interface McpMethodBreakdownItem {
  method: string;
  count: number;
  error_count: number;
  avg_duration_ms: number | null;
}

export async function getMcpMethodBreakdown(params: McpStatsQueryParams): Promise<McpMethodBreakdownItem[]> {
  const timePart = buildTimeClause(params, 1);
  const dimPart = buildDimClause(params, timePart.nextIdx);
  const values = [...timePart.values, ...dimPart.values];

  const sql = `
    SELECT
      method,
      COUNT(*)::int                                        AS count,
      COUNT(*) FILTER (WHERE error IS NOT NULL)::int       AS error_count,
      AVG(duration_ms)                                     AS avg_duration_ms
    FROM mcp_logs
    WHERE ${timePart.clause}
    ${dimPart.clause}
    GROUP BY method
    ORDER BY count DESC
    LIMIT 20
  `;

  const result = await db.query<{
    method: string;
    count: number;
    error_count: number;
    avg_duration_ms: number | null;
  }>(sql, values);

  return result.rows.map((r) => ({
    method: r.method,
    count: r.count,
    error_count: r.error_count,
    avg_duration_ms: r.avg_duration_ms === null ? null : Math.round(r.avg_duration_ms),
  }));
}
