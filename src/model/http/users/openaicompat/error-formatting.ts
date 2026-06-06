// src/users/openaicompat/error-formatting.ts — OpenAI 兼容格式错误响应

import type { ErrorResponsePayload } from '@/model/http/users/types';
import { GatewayError } from '@/utils/errors';

/**
 * 构建 OpenAI 兼容格式的错误响应体（不发送）
 *
 * GatewayError → `{ error: { code, message, type: 'gateway_error' }, choices: [] }`
 * 其他异常    → `{ error: { code: 'internal_error', message, type: 'internal_error' }, choices: [] }`
 *
 * choices: [] 的附加说明：
 * VS Code Copilot 扩展调用 _provideLanguageModelResponse 时强制要求响应中包含
 * choices 数组。缺少该字段将导致 "Response contained no choices" 客户端错误。
 * 标准 OpenAI 客户端（curl、openai SDK 等）会优先检测 error 字段并忽略 choices，
 * 因此附带空 choices 对它们无副作用。
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
        choices: [],
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
      choices: [],
    },
  };
}
