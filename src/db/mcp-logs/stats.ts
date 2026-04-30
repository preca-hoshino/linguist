// src/db/mcp-logs/stats.ts — MCP 日志统计聚合查询

import { db } from '@/db/client';
import { autoInterval, buildBucketExpr, floorToInterval } from '../stats/helpers';
import type { StatsInterval } from '../stats/types';

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
      clause: `m.created_at >= $${String(startIdx)} AND m.created_at < $${String(startIdx + 1)}`,
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
    clause: `m.created_at >= NOW() - INTERVAL '${interval}'`,
    values: [],
    nextIdx: startIdx,
  };
}

function buildDimClause(
  params: McpStatsQueryParams,
  startIdx: number,
): { clause: string; values: unknown[]; nextIdx: number } {
  if (params.dimension === 'mcp_provider' && params.id !== undefined) {
    return { clause: `AND m.mcp_provider_id = $${String(startIdx)}`, values: [params.id], nextIdx: startIdx + 1 };
  }
  if (params.dimension === 'virtual_mcp' && params.id !== undefined) {
    return { clause: `AND m.virtual_mcp_id = $${String(startIdx)}`, values: [params.id], nextIdx: startIdx + 1 };
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
      COUNT(*) FILTER (WHERE m.status = 'error')::int            AS error_count,
      PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY m.duration_ms) AS avg_duration_ms,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY m.duration_ms) AS p95_duration_ms
    FROM mcp_logs m
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
  p95_duration_ms: number | null;
  p99_duration_ms: number | null;
}

function resolveInterval(params: McpStatsQueryParams, override?: McpStatsInterval): McpStatsInterval {
  if (override !== undefined) {
    return override;
  }
  const autoMap: Record<McpStatsRange, McpStatsInterval> = {
    '15m': '1m',
    '1h': '5m',
    '6h': '15m',
    '24h': '1h',
    '7d': '6h',
    '14d': '6h',
    '30d': '1d',
  };
  return autoMap[params.range ?? '1h'];
}

export async function getMcpStatsTimeSeries(
  params: McpStatsQueryParams,
  interval?: McpStatsInterval,
): Promise<McpStatsTimeSeriesPoint[]> {
  const intervalKey = resolveInterval(params, interval);
  const { expr: bucketExpr, pgInterval } = buildBucketExpr(intervalKey as StatsInterval);
  const timePart = buildTimeClause(params, 1);
  const dimPart = buildDimClause(params, timePart.nextIdx);
  const values = [...timePart.values, ...dimPart.values];

  // 计算 generate_series 的起始时间（对齐到粒度边界）
  let seriesStart: string;
  let seriesEnd: string;
  if (params.from !== undefined && params.to !== undefined) {
    seriesStart = floorToInterval(new Date(params.from), intervalKey as StatsInterval).toISOString();
    seriesEnd = params.to;
  } else {
    const autoIvKey = autoInterval(params.range ?? '1h');
    const now = new Date();
    const rangeMap: Record<McpStatsRange, number> = {
      '15m': 15,
      '1h': 60,
      '6h': 360,
      '24h': 1440,
      '7d': 10_080,
      '14d': 20_160,
      '30d': 43_200,
    };
    const startDate = new Date(now.getTime() - rangeMap[params.range ?? '1h'] * 60_000);
    seriesStart = floorToInterval(startDate, autoIvKey).toISOString();
    seriesEnd = now.toISOString();
  }

  const sql = `
    WITH
      series AS (
        SELECT generate_series(
          $${String(timePart.values.length + dimPart.values.length + 1)}::timestamptz,
          $${String(timePart.values.length + dimPart.values.length + 2)}::timestamptz,
          INTERVAL '${pgInterval}'
        ) AS ts
      ),
      data AS (
        SELECT
          ${bucketExpr} AS ts,
          COUNT(*)::int                                               AS requests,
          COUNT(*) FILTER (WHERE m.status = 'error')::int            AS errors,
          AVG(m.duration_ms)                                          AS avg_duration_ms,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY m.duration_ms) AS p95_duration_ms,
          PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY m.duration_ms) AS p99_duration_ms
        FROM mcp_logs m
        WHERE ${timePart.clause}
        ${dimPart.clause}
        GROUP BY 1
      )
    SELECT
      s.ts,
      COALESCE(d.requests, 0)      AS requests,
      COALESCE(d.errors, 0)        AS errors,
      d.avg_duration_ms,
      d.p95_duration_ms,
      d.p99_duration_ms
    FROM series s
    LEFT JOIN data d ON d.ts = s.ts
    ORDER BY s.ts
  `;

  const extValues = [...values, seriesStart, seriesEnd];

  const result = await db.query<{
    ts: string;
    requests: number;
    errors: number;
    avg_duration_ms: number | null;
    p95_duration_ms: number | null;
    p99_duration_ms: number | null;
  }>(sql, extValues);

  return result.rows.map((r) => ({
    ts: r.ts,
    requests: r.requests,
    errors: r.errors,
    avg_duration_ms: r.avg_duration_ms === null ? null : Math.round(r.avg_duration_ms),
    p95_duration_ms: r.p95_duration_ms === null ? null : Math.round(r.p95_duration_ms),
    p99_duration_ms: r.p99_duration_ms === null ? null : Math.round(r.p99_duration_ms),
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
      m.method,
      COUNT(*)::int                                        AS count,
      COUNT(*) FILTER (WHERE m.status = 'error')::int     AS error_count,
      AVG(m.duration_ms)                                   AS avg_duration_ms
    FROM mcp_logs m
    WHERE ${timePart.clause}
    ${dimPart.clause}
    GROUP BY m.method
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

// ── MCP 分布排行统计 ─────────────────────────────────────────────────────────

export interface McpStatsDistributionItem {
  id: string | null;
  name: string;
  count: number;
  error_count: number;
  avg_duration_ms: number | null;
}

export async function getMcpDistribution(
  params: McpStatsQueryParams,
  groupBy: 'virtual_mcp' | 'mcp_provider',
): Promise<McpStatsDistributionItem[]> {
  const timePart = buildTimeClause(params, 1);
  const dimPart = buildDimClause(params, timePart.nextIdx);
  const values = [...timePart.values, ...dimPart.values];

  let sql = '';
  if (groupBy === 'virtual_mcp') {
    sql = `
      SELECT
        m.virtual_mcp_id AS id,
        COALESCE(v.name, m.virtual_mcp_id::text, 'unknown') AS name,
        COUNT(*)::int                                       AS count,
        COUNT(*) FILTER (WHERE m.status = 'error')::int     AS error_count,
        AVG(m.duration_ms)                                  AS avg_duration_ms
      FROM mcp_logs m
      LEFT JOIN virtual_mcps v ON v.id = m.virtual_mcp_id
      WHERE ${timePart.clause}
      ${dimPart.clause}
      GROUP BY m.virtual_mcp_id, v.name
      ORDER BY count DESC
      LIMIT 10
    `;
  } else {
    sql = `
      SELECT
        m.mcp_provider_id AS id,
        COALESCE(p.name, m.mcp_provider_id::text, 'unknown') AS name,
        COUNT(*)::int                                        AS count,
        COUNT(*) FILTER (WHERE m.status = 'error')::int      AS error_count,
        AVG(m.duration_ms)                                   AS avg_duration_ms
      FROM mcp_logs m
      LEFT JOIN mcp_providers p ON p.id = m.mcp_provider_id
      WHERE ${timePart.clause}
      ${dimPart.clause}
      GROUP BY m.mcp_provider_id, p.name
      ORDER BY count DESC
      LIMIT 10
    `;
  }

  const result = await db.query<{
    id: string | null;
    name: string;
    count: number;
    error_count: number;
    avg_duration_ms: number | null;
  }>(sql, values);

  return result.rows.map((r) => ({
    id: r.id,
    name: r.name,
    count: r.count,
    error_count: r.error_count,
    avg_duration_ms: r.avg_duration_ms === null ? null : Math.round(r.avg_duration_ms),
  }));
}

// ── 今日统计（单 CTE 多目标扫描） ────────────────────────────────────────────────

export interface McpStatsToday {
  today_requests: number;
  today_errors: number;
  current_rpm: number;
  avg_duration_ms: number | null;
  p95_duration_ms: number | null;
}

/**
 * 今日 MCP 统计：单次扫描 mcp_logs 热表，三个 CTE 分别计算当日汇总、近 5 分钟 RPM、近 1000 条 Latency 样本。
 * - 优化 1：三 CTE CROSS JOIN，不重复扫描热表
 * - 优化 2：latency_sample 限 ORDER BY created_at DESC LIMIT 1000 后再做 PERCENTILE_CONT
 * - 优化 3：零冷表 JOIN
 * - 优化 4：RPM 用近 5 分钟窗口 ÷ 5 平滑
 */
export async function getMcpStatsToday(): Promise<McpStatsToday> {
  const sql = `
    WITH
      today_agg AS (
        SELECT
          COUNT(*)::int                             AS today_requests,
          COUNT(*) FILTER (WHERE status = 'error')::int AS today_errors
        FROM mcp_logs
        WHERE created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      ),
      rpm_agg AS (
        SELECT COUNT(*)::int AS cnt_5m
        FROM mcp_logs
        WHERE created_at >= NOW() - INTERVAL '5 minutes'
      ),
      latency_sample AS (
        SELECT duration_ms
        FROM mcp_logs
        WHERE created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
          AND duration_ms IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 1000
      ),
      latency_agg AS (
        SELECT
          AVG(duration_ms)                                          AS avg_duration_ms,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_duration_ms
        FROM latency_sample
      )
    SELECT
      t.today_requests,
      t.today_errors,
      ROUND((r.cnt_5m::numeric / 5), 2)            AS current_rpm,
      l.avg_duration_ms,
      l.p95_duration_ms
    FROM today_agg t
    CROSS JOIN rpm_agg r
    CROSS JOIN latency_agg l
  `;

  const result = await db.query<{
    today_requests: number;
    today_errors: number;
    current_rpm: string;
    avg_duration_ms: number | null;
    p95_duration_ms: number | null;
  }>(sql, []);

  const row = result.rows[0];
  if (!row) {
    return { today_requests: 0, today_errors: 0, current_rpm: 0, avg_duration_ms: null, p95_duration_ms: null };
  }
  return {
    today_requests: row.today_requests,
    today_errors: row.today_errors,
    current_rpm: parseFloat(row.current_rpm),
    avg_duration_ms: row.avg_duration_ms === null ? null : Math.round(row.avg_duration_ms),
    p95_duration_ms: row.p95_duration_ms === null ? null : Math.round(row.p95_duration_ms),
  };
}

// ── 错误分析（单 CTE 多聚合） ─────────────────────────────────────────────────────

export interface McpStatsErrorByMethod {
  method: string;
  count: number;
}

export interface McpStatsErrorSample {
  id: string;
  method: string;
  error_message: string | null;
  created_at: string;
}

export interface McpStatsErrors {
  total_errors: number;
  error_rate: number;
  by_method: McpStatsErrorByMethod[];
  recent_samples: McpStatsErrorSample[];
}

/**
 * MCP 错误分析：base CTE 一次过滤，SELECT 层分别聚合 total / by_method。
 * - 优化 1：base CTE 一次过滤，SELECT 层分别聚合
 * - 优化 2：最近 10 条错误样本独立查询，不干扰主聚合
 * - 优化 3：零冷表 JOIN
 */
export async function getMcpStatsErrors(params: McpStatsQueryParams): Promise<McpStatsErrors> {
  const timePart = buildTimeClause(params, 1);
  const dimPart = buildDimClause(params, timePart.nextIdx);
  const values = [...timePart.values, ...dimPart.values];

  const sql = `
    WITH base AS (
      SELECT method, status, error_message, id, created_at
      FROM mcp_logs m
      WHERE ${timePart.clause}
      ${dimPart.clause}
    ),
    total_agg AS (
      SELECT
        COUNT(*)::int                             AS total_requests,
        COUNT(*) FILTER (WHERE status = 'error')::int AS total_errors
      FROM base
    ),
    method_agg AS (
      SELECT method, COUNT(*)::int AS count
      FROM base
      WHERE status = 'error'
      GROUP BY method
      ORDER BY count DESC
      LIMIT 10
    )
    SELECT
      (SELECT total_requests FROM total_agg) AS total_requests,
      (SELECT total_errors FROM total_agg)   AS total_errors,
      (SELECT json_agg(json_build_object('method', method, 'count', count) ORDER BY count DESC) FROM method_agg) AS by_method
  `;

  const sampleSql = `
    SELECT id, method, error_message, created_at
    FROM mcp_logs m
    WHERE ${timePart.clause}
    ${dimPart.clause}
    AND m.status = 'error'
    ORDER BY m.created_at DESC
    LIMIT 10
  `;

  const [mainResult, sampleResult] = await Promise.all([
    db.query<{
      total_requests: number;
      total_errors: number;
      by_method: McpStatsErrorByMethod[] | null;
    }>(sql, values),
    db.query<{ id: string; method: string; error_message: string | null; created_at: string }>(sampleSql, values),
  ]);

  const row = mainResult.rows[0];
  if (!row) {
    return { total_errors: 0, error_rate: 0, by_method: [], recent_samples: [] };
  }

  const total = row.total_requests;
  const errors = row.total_errors;
  return {
    total_errors: errors,
    error_rate: total > 0 ? Math.round((errors / total) * 10_000) / 10_000 : 0,
    by_method: row.by_method ?? [],
    recent_samples: sampleResult.rows,
  };
}
