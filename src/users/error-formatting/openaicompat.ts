// src/users/error-formatting/openaicompat.ts — OpenAI 兼容格式错误响应

import { GatewayError } from '../../utils/errors';

/** 错误响应载荷（HTTP 状态码 + JSON 响应体） */
export interface ErrorResponsePayload {
  status: number;
  body: Record<string, unknown>;
}

/**
 * 构建 OpenAI 兼容格式的错误响应体（不发送）
 *
 * GatewayError → `{ error: { code, message, type: 'gateway_error' } }`
 * 其他异常    → `{ error: { code: 'internal_error', message, type: 'internal_error' } }`
 */
export function buildOpenAICompatErrorBody(err: unknown): ErrorResponsePayload {
  if (err instanceof GatewayError) {
    return {
      status: err.statusCode,
      body: {
        error: {
          code: err.errorCode,
          message: err.message,
          type: 'gateway_error',
        },
      },
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  return {
    status: 500,
    body: {
      error: {
        code: 'internal_error',
        message: message,
        type: 'internal_error',
      },
    },
  };
}
