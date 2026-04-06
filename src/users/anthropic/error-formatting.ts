// src/users/claude/error-formatting.ts — Anthropic 格式错误响应

import type { ErrorResponsePayload } from '@/users/types';
import { GatewayError } from '@/utils/errors';

/**
 * 内部错误码 → Anthropic error.type 映射
 *
 * Anthropic 错误格式:
 * {
 *   type: "error",
 *   error: {
 *     type: "invalid_request_error" | "authentication_error" | "not_found_error" | ...,
 *     message: "..."
 *   }
 * }
 */
function mapErrorType(statusCode: number): string {
  switch (statusCode) {
    case 400: {
      return 'invalid_request_error';
    }
    case 401: {
      return 'authentication_error';
    }
    case 403: {
      return 'permission_error';
    }
    case 404: {
      return 'not_found_error';
    }
    case 429: {
      return 'rate_limit_error';
    }
    case 529: {
      return 'overloaded_error';
    }
    default: {
      return 'api_error';
    }
  }
}

/**
 * 构建 Anthropic 格式的错误响应体（不发送）
 */
export function buildAnthropicErrorBody(err: unknown): ErrorResponsePayload {
  if (err instanceof GatewayError) {
    return {
      status: err.statusCode,
      body: {
        type: 'error',
        error: {
          type: mapErrorType(err.statusCode),
          message: err.message,
        },
      },
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  return {
    status: 500,
    body: {
      type: 'error',
      error: {
        type: 'api_error',
        message,
      },
    },
  };
}
