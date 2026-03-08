// src/users/error-formatting/gemini.ts — Gemini 格式错误响应
//
// Gemini 使用 gRPC 风格错误结构：
// { "error": { "code": <httpStatus>, "message": "...", "status": "<gRPC_STATUS>" } }

import { GatewayError } from '../../utils/errors';
import type { ErrorResponsePayload } from './openaicompat';

/** HTTP 状态码 → gRPC 状态字符串 */
const HTTP_TO_GRPC_STATUS: Record<number, string> = {
  400: 'INVALID_ARGUMENT',
  401: 'UNAUTHENTICATED',
  402: 'FAILED_PRECONDITION',
  403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND',
  422: 'INVALID_ARGUMENT',
  429: 'RESOURCE_EXHAUSTED',
  500: 'INTERNAL',
  502: 'UNAVAILABLE',
  503: 'UNAVAILABLE',
  504: 'DEADLINE_EXCEEDED',
};

/**
 * 构建 Gemini 格式的错误响应体（不发送）
 *
 * GatewayError → `{ error: { code, message, status } }` （status 为 gRPC 状态字符串）
 * 其他异常    → `{ error: { code: 500, message, status: 'INTERNAL' } }`
 */
export function buildGeminiErrorBody(err: unknown): ErrorResponsePayload {
  if (err instanceof GatewayError) {
    const grpcStatus = HTTP_TO_GRPC_STATUS[err.statusCode] ?? 'INTERNAL';
    return {
      status: err.statusCode,
      body: {
        error: {
          code: err.statusCode,
          message: err.message,
          status: grpcStatus,
        },
      },
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  return {
    status: 500,
    body: {
      error: {
        code: 500,
        message,
        status: 'INTERNAL',
      },
    },
  };
}
