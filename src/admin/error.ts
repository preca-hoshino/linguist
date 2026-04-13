// src/admin/error.ts — 管理 API 统一错误处理器
//
// 与 src/users/handleError 解耦（后者含 userFormat 参数，属于网关 API 侧）。
// 所有管理 API 路由统一使用本模块的 handleAdminError。

import type { Response } from 'express';
import type { ApiErrorResponse, ApiErrorType } from '@/types/api';
import { createLogger, GatewayError, logColors } from '@/utils';

const logger = createLogger('Admin:Error', logColors.bold + logColors.red);

/** 将 HTTP 状态码映射到 ApiErrorType */
function toErrorType(status: number): ApiErrorType {
  if (status === 401 || status === 403) {
    return 'authentication_error';
  }
  if (status === 404) {
    return 'not_found_error';
  }
  if (status === 409) {
    return 'conflict_error';
  }
  if (status >= 500) {
    return 'server_error';
  }
  return 'invalid_request_error';
}

/**
 * 管理 API 统一错误处理器
 *
 * - err: unknown（符合 Google TS 规范，不用 any）
 * - 输出标准 { error: { code, message, type, param } } 结构
 */
export function handleAdminError(err: unknown, res: Response): void {
  if (err instanceof GatewayError) {
    const body: ApiErrorResponse = {
      error: {
        code: err.errorCode,
        message: err.message,
        type: toErrorType(err.statusCode),
        param: null,
      },
    };
    res.status(err.statusCode).json(body);
    return;
  }

  // 拦截 Postgres 唯一约束与外键约束违规
  const pgErr = err as Record<string, unknown> | null;
  if (pgErr && typeof pgErr.code === 'string') {
    const tableStr = typeof pgErr.table === 'string' ? pgErr.table : 'unknown';
    if (pgErr.code === '23503') {
      res.status(400).json({
        error: {
          code: 'invalid_reference',
          message: `Foreign key constraint violation on table ${tableStr}: referenced record does not exist.`,
          type: 'invalid_request_error',
          param: null,
        },
      } satisfies ApiErrorResponse);
      return;
    }
    if (pgErr.code === '23505') {
      res.status(409).json({
        error: {
          code: 'conflict_error',
          message: `Unique constraint violation on table ${tableStr}.`,
          type: 'conflict_error',
          param: null,
        },
      } satisfies ApiErrorResponse);
      return;
    }
  }

  // 非预期错误：记录日志并返回通用 500
  logger.error(err instanceof Error ? err : new Error(String(err)), 'Unhandled admin error');
  const body: ApiErrorResponse = {
    error: {
      code: 'internal_error',
      message: 'Internal server error',
      type: 'server_error',
      param: null,
    },
  };
  res.status(500).json(body);
}
