// src/types/api.ts — 管理 API 公共类型系统
//
// 定义统一的响应结构和错误格式，供 src/admin/ 路由和前端共用。
// 遵循 Stripe API 风格的 object 字段约定。

// ==================== object 字段联合类型 ====================

// ==================== 统一响应接口 ====================

// ==================== 统一错误接口 ====================

/**
 * 错误类型分类（对齐 Stripe API 错误类型）
 *
 * - invalid_request_error: 客户端输入错误（400）
 * - authentication_error: 认证失败（401/403）
 * - not_found_error: 资源不存在（404）
 * - conflict_error: 资源冲突（409）
 * - server_error: 服务端内部错误（500/503）
 */
export type ApiErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'not_found_error'
  | 'conflict_error'
  | 'server_error';

/** 统一错误响应体 */
export interface ApiErrorBody {
  readonly code: string;
  readonly message: string;
  readonly type: ApiErrorType;
  readonly param: string | null;
}

/** 统一错误响应（所有管理 API 错误均使用此格式） */
export interface ApiErrorResponse {
  readonly error: ApiErrorBody;
}
