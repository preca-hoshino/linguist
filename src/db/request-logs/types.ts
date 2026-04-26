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
 * 列表专用日志条目（仅窄表字段，不含 JSONB，用于分页列表接口）
 *
 * 直接使用 request_logs 窄表独立列（duration_ms/ttft_ms/user_format），
 * 无需 JOIN request_log_details 宽表。
 */
export interface RequestLogListItem {
  id: string;
  status: RequestLogStatus;
  request_model: string | null;
  routed_model: string | null;
  provider_kind: string | null;
  provider_id: string | null;
  app_id: string | null;
  is_stream: boolean | null;
  error_type: ErrorType | null;
  error_code: string | null;
  error_message: string | null;
  calculated_cost: number | null;
  /** 全链路延迟（窄表列，无需 JOIN 计算） */
  duration_ms: number | null;
  /** 首 Token 延迟（窄表列） */
  ttft_ms: number | null;
  /** 客户端格式（窄表列，可直接用于过滤/分组） */
  user_format: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * 详情页完整日志条目（含 JSONB 宽表，仅用于单行按 ID 点查）
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
  created_at: string;
  updated_at: string;
  /** ModelHttpContext 完整快照（唯一审计数据源） */
  gateway_context: Record<string, unknown> | null;
}

/** 查询筛选参数 */
export interface RequestLogQuery {
  status?: RequestLogStatus | string[] | undefined;
  request_model?: string | undefined;
  provider_kind?: string | string[] | undefined;
  provider_id?: string | string[] | undefined;
  error_type?: string | string[] | undefined;
  /** 按客户端格式过滤（使用窄表列 user_format，无需 JOIN 宽表） */
  user_format?: string | string[] | undefined;
  is_stream?: string | string[] | boolean | undefined;
  app_id?: string | string[] | undefined;
  /** Offset 分页（替代游标分页） */
  offset?: number | undefined;
  limit?: number | undefined;
}

/** 详情查询列：仅用于单行按 ID 点查（JOIN 宽表） */
export const ENTRY_COLUMNS: string = `
  r.id, r.status, r.error_type, r.error_code, r.error_message,
  r.duration_ms,
  r.calculated_cost,
  r.created_at, r.updated_at, d.gateway_context
`.trim();

/** 列表查询列：仅查窄表（严禁 JOIN request_log_details） */
export const LIST_COLUMNS: string = `
  r.id, r.status, r.request_model, r.routed_model, r.provider_kind, r.provider_id,
  r.app_id, r.is_stream, r.error_type, r.error_code, r.error_message,
  r.calculated_cost, r.duration_ms, r.ttft_ms, r.user_format,
  r.created_at, r.updated_at
`.trim();
