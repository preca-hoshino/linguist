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
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type RequestLogEntry = {
  id: string;
  status: RequestLogStatus;
  error_type: ErrorType | null;
  error_code: string | null;
  error_message: string | null;
  duration_ms: number | null;
  created_at: string;
  updated_at: string;
  /** GatewayContext 完整快照（唯一审计数据源） */
  gateway_context: Record<string, unknown> | null;
};

/** 查询筛选参数 */
export interface RequestLogQuery {
  status?: RequestLogStatus | undefined;
  request_model?: string | undefined;
  provider_kind?: string | undefined;
  error_type?: string | undefined;
  api_key_prefix?: string | undefined;
  is_stream?: boolean | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

/** 统一查询列：仅返回 DB 元数据 + gateway_context */
export const ENTRY_COLUMNS = `
  id, status, error_type, error_code, error_message,
  CASE
    WHEN (timing->>'end') IS NOT NULL AND (timing->>'start') IS NOT NULL
    THEN ((timing->>'end')::float - (timing->>'start')::float)::int
    ELSE NULL
  END AS duration_ms,
  created_at, updated_at, gateway_context
`.trim();
