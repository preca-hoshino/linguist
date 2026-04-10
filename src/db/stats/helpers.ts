// src/db/stats/helpers.ts — 统计查询公共辅助函数与 SQL 构建器

import type { StatsDimension, StatsInterval, StatsQueryParams, StatsRange } from './types';

// ==================== SQL 表达式构建器 ====================

/**
 * 总延迟 SQL 表达式（从 timing JSON 计算，单位毫秒）
 * @param alias 可选表别名（如 'rl'），用于联表查询
 */
export function latencyExpr(alias = ''): string {
  const t = alias ? `${alias}.timing` : 'timing';
  return `CASE WHEN ${t}->>'end' IS NOT NULL AND ${t}->>'start' IS NOT NULL
    THEN (${t}->>'end')::float - (${t}->>'start')::float END`;
}

export function ttftExpr(alias = ''): string {
  const t = alias ? `${alias}.timing` : 'timing';
  return `CASE WHEN ${t}->>'ttft' IS NOT NULL AND ${t}->>'start' IS NOT NULL
    THEN (${t}->>'ttft')::float - (${t}->>'start')::float END`;
}

export function itlExpr(aliasTiming = '', aliasTokens = ''): string {
  const t = aliasTiming ? `${aliasTiming}.timing` : 'timing';
  const c = aliasTokens ? `${aliasTokens}.completion_tokens` : 'completion_tokens';
  return `CASE WHEN ${t}->>'end' IS NOT NULL AND ${t}->>'ttft' IS NOT NULL AND ${c} IS NOT NULL
    THEN ((${t}->>'end')::float - (${t}->>'ttft')::float) / NULLIF(${c}, 0) END`;
}

// ==================== 数值计算工具 ====================

/** 四舍五入到 2 位小数 */
export function roundRate(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 安全比率计算（避免除零），保留 4 位小数 */
export function safeRate(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round((numerator / denominator) * 10_000) / 10_000 : 0;
}

/** 四舍五入 number | null */
export function roundOrNull(v: number | null): number | null {
  return v === null ? null : Math.round(v);
}

// ==================== 时间范围工具 ====================

/** 将 range 字符串转为 PostgreSQL interval */
function rangeToInterval(range: StatsRange): string {
  const map: Record<StatsRange, string> = {
    '15m': '15 minutes',
    '1h': '1 hour',
    '6h': '6 hours',
    '24h': '24 hours',
    '7d': '7 days',
    '14d': '14 days',
    '30d': '30 days',
  };
  return map[range];
}

/** 将 range 转为分钟数（用于计算 RPM/TPM） */
export function rangeToMinutes(range: StatsRange): number {
  const map: Record<StatsRange, number> = {
    '15m': 15,
    '1h': 60,
    '6h': 360,
    '24h': 1440,
    '7d': 10_080,
    '14d': 20_160,
    '30d': 43_200,
  };
  return map[range];
}

/** 根据 range 自动选择合理的时间粒度 */
export function autoInterval(range: StatsRange): StatsInterval {
  const map: Record<StatsRange, StatsInterval> = {
    '15m': '1m',
    '1h': '1m', // ~60 段
    '6h': '5m', // ~72 段
    '24h': '5m', // ~288 段
    '7d': '1h', // ~168 段
    '14d': '6h', // ~56 段
    '30d': '6h', // ~120 段
  };
  return map[range];
}

/** 根据自定义日期范围自动选择粒度（目标约 60~300 段） */
export function autoIntervalForDates(from: Date, to: Date): StatsInterval {
  const hours = (to.getTime() - from.getTime()) / (1000 * 60 * 60);
  if (hours <= 2) {
    return '1m'; // ≤2h → ≤120 段
  }
  if (hours <= 6) {
    return '5m'; // ≤6h → ≤72 段
  }
  if (hours <= 24) {
    return '10m'; // ≤24h → ≤144 段
  }
  if (hours <= 48) {
    return '1h'; // ≤2d → ≤48 段
  }
  if (hours <= 168) {
    return '6h'; // ≤7d → ≤28 段
  }
  return '1d'; // >7d
}

/**
 * 将时间向下对齐到时间粒度边界（UTC）
 * 用于 generate_series 起始对齐，保证 bucket 与 bucket_expr 精确匹配
 */
export function floorToInterval(date: Date, interval: StatsInterval): Date {
  const d = new Date(date);
  switch (interval) {
    case '1m': {
      d.setUTCSeconds(0, 0);
      return d;
    }
    case '5m': {
      d.setUTCSeconds(0, 0);
      d.setUTCMinutes(Math.floor(d.getUTCMinutes() / 5) * 5);
      return d;
    }
    case '10m': {
      d.setUTCSeconds(0, 0);
      d.setUTCMinutes(Math.floor(d.getUTCMinutes() / 10) * 10);
      return d;
    }
    case '15m': {
      d.setUTCSeconds(0, 0);
      d.setUTCMinutes(Math.floor(d.getUTCMinutes() / 15) * 15);
      return d;
    }
    case '1h': {
      d.setUTCMinutes(0, 0, 0);
      return d;
    }
    case '6h': {
      d.setUTCMinutes(0, 0, 0);
      d.setUTCHours(Math.floor(d.getUTCHours() / 6) * 6);
      return d;
    }
    case '1d': {
      d.setUTCHours(0, 0, 0, 0);
      return d;
    }
  }
}

/** 从查询参数获取时间窗口分钟数（用于 RPM/TPM 计算） */
export function getWindowMinutes(params: StatsQueryParams): number {
  if (params.from !== undefined && params.to !== undefined) {
    const diffMs = new Date(params.to).getTime() - new Date(params.from).getTime();
    return Math.max(1, Math.round(diffMs / 60_000));
  }
  return rangeToMinutes(params.range ?? '1h');
}

// ==================== SQL 子句构建器 ====================

/**
 * 构建时间过滤子句
 * 若 from/to 已提供，使用参数化查询；否则使用 range 字符串插值（已验证安全）
 */
export function buildTimeFilter(
  params: StatsQueryParams,
  startParamIdx: number,
): { clause: string; values: unknown[]; nextIdx: number } {
  if (params.from !== undefined && params.to !== undefined) {
    return {
      clause: `created_at >= $${String(startParamIdx)} AND created_at < $${String(startParamIdx + 1)}`,
      values: [params.from, params.to],
      nextIdx: startParamIdx + 2,
    };
  }
  const pgInterval = rangeToInterval(params.range ?? '1h');
  return {
    clause: `created_at >= NOW() - INTERVAL '${pgInterval}'`,
    values: [],
    nextIdx: startParamIdx,
  };
}

/** 构建维度过滤条件 */
export function buildDimensionFilter(
  dimension: StatsDimension,
  id: string | undefined,
  paramIdx: number,
): { clause: string; values: unknown[]; nextIdx: number } {
  if (dimension === 'global' || id === undefined || id === '') {
    return { clause: '', values: [], nextIdx: paramIdx };
  }

  const columnMap: Record<Exclude<StatsDimension, 'global'>, string> = {
    provider: 'provider_id',
    provider_model: 'routed_model',
    virtual_model: 'request_model',
    app: 'app_id',
    api_key: 'api_key_prefix',
  };

  const column = columnMap[dimension];
  return {
    clause: `AND ${column} = $${String(paramIdx)}`,
    values: [id],
    nextIdx: paramIdx + 1,
  };
}

/**
 * 构建维度过滤条件（带表别名，用于联表查询）
 */
export function buildDimensionFilterAliased(
  dimension: StatsDimension,
  id: string | undefined,
  paramIdx: number,
  alias: string,
): { clause: string; values: unknown[]; nextIdx: number } {
  if (dimension === 'global' || id === undefined || id === '') {
    return { clause: '', values: [], nextIdx: paramIdx };
  }

  const columnMap: Record<Exclude<StatsDimension, 'global'>, string> = {
    provider: 'provider_id',
    provider_model: 'routed_model',
    virtual_model: 'request_model',
    app: 'app_id',
    api_key: 'api_key_prefix',
  };

  const column = `${alias}.${columnMap[dimension]}`;
  return {
    clause: `AND ${column} = $${String(paramIdx)}`,
    values: [id],
    nextIdx: paramIdx + 1,
  };
}

/** 生成不同时间粒度对应的 SQL bucket 表达式、桶时长（分钟）和 PG interval 字符串 */
export function buildBucketExpr(interval: StatsInterval): { expr: string; minutes: number; pgInterval: string } {
  switch (interval) {
    case '1m': {
      return {
        expr: `date_trunc('minute', created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
        minutes: 1,
        pgInterval: '1 minute',
      };
    }
    case '5m': {
      return {
        expr: `(
          date_trunc('minute', created_at AT TIME ZONE 'UTC')
          - (EXTRACT(minute FROM created_at AT TIME ZONE 'UTC')::int % 5) * INTERVAL '1 minute'
        ) AT TIME ZONE 'UTC'`,
        minutes: 5,
        pgInterval: '5 minutes',
      };
    }
    case '10m': {
      return {
        expr: `(
          date_trunc('minute', created_at AT TIME ZONE 'UTC')
          - (EXTRACT(minute FROM created_at AT TIME ZONE 'UTC')::int % 10) * INTERVAL '1 minute'
        ) AT TIME ZONE 'UTC'`,
        minutes: 10,
        pgInterval: '10 minutes',
      };
    }
    case '15m': {
      return {
        expr: `(
          date_trunc('minute', created_at AT TIME ZONE 'UTC')
          - (EXTRACT(minute FROM created_at AT TIME ZONE 'UTC')::int % 15) * INTERVAL '1 minute'
        ) AT TIME ZONE 'UTC'`,
        minutes: 15,
        pgInterval: '15 minutes',
      };
    }
    case '1h': {
      return {
        expr: `date_trunc('hour', created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
        minutes: 60,
        pgInterval: '1 hour',
      };
    }
    case '6h': {
      return {
        expr: `(
          date_trunc('hour', created_at AT TIME ZONE 'UTC')
          - (EXTRACT(hour FROM created_at AT TIME ZONE 'UTC')::int % 6) * INTERVAL '1 hour'
        ) AT TIME ZONE 'UTC'`,
        minutes: 360,
        pgInterval: '6 hours',
      };
    }
    case '1d': {
      return {
        expr: `date_trunc('day', created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
        minutes: 1440,
        pgInterval: '1 day',
      };
    }
  }
}
