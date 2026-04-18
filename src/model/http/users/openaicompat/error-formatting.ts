// src/users/openaicompat/error-formatting.ts — OpenAI 兼容格式错误响应

import type { ErrorResponsePayload } from '@/model/http/users/types';
import { GatewayError } from '@/utils/errors';

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
