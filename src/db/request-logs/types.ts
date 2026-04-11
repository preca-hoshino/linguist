// src/db/request-logs/types.ts — 请求日志类型定义

/** 请求日志状态 */
export type RequestLogStatus = 'processing' | 'completed' | 'error';

/** 错误类型枚举 */
export type ErrorType =
  | 'rate_limit'
  | 'timeout'
  | 'provider_error'
  | 'auth_error'
  | 'invalid_request'
  | 'internal_error';

/**
 * 请求日志条目（统一类型，列表和详情共用）
 *
 * 仅保留 DB 元数据字段（状态、错误分类、计时、时间戳）+ gateway_context 完整快照。
 * 用户/路由/Token 等业务数据全部从 gateway_context 读取，不再重复返回。
 *
 * 使用 type 而非 interface：type alias 拥有隐式索引签名，
 * 可满足 db.query<T extends Record<string, unknown>> 的泛型约束。
 */

export interface RequestLogEntry {
  id: string;
  status: RequestLogStatus;
  error_type: ErrorType | null;
  error_code: string | null;
  error_message: string | null;
  duration_ms: number | null;
  /** 后置计费总额 */
  calculated_cost: number | null;
  /** 计费明细快照（输入/缓存/输出各部分费用） */
  cost_breakdown: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  /** ModelHttpContext 完整快照（唯一审计数据源） */
  gateway_context: Record<string, unknown> | null;
}

/** 查询筛选参数 */
export interface RequestLogQuery {
  status?: RequestLogStatus | undefined;
  request_model?: string | undefined;
  provider_kind?: string | undefined;
  provider_id?: string | undefined;
  error_type?: string | undefined;
  api_key_prefix?: string | undefined;
  user_format?: string | undefined;
  is_stream?: boolean | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

/** 统一查询列：仅返回 DB 元数据 + gateway_context */
export const ENTRY_COLUMNS: string = `
  r.id, r.status, r.error_type, r.error_code, r.error_message,
  CASE
    WHEN (d.timing->>'end') IS NOT NULL AND (d.timing->>'start') IS NOT NULL
    THEN ((d.timing->>'end')::float - (d.timing->>'start')::float)::int
    ELSE NULL
  END AS duration_ms,
  r.calculated_cost, d.cost_breakdown,
  r.created_at, r.updated_at, d.gateway_context
`.trim();
