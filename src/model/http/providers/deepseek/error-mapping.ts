// src/providers/error-mapping/deepseek.ts — DeepSeek 错误映射
//
// DeepSeek 使用 OpenAI 兼容错误格式：
// { "error": { "message": "...", "type": "...", "code": "..." } }
// 主要依赖 HTTP 状态码区分错误类型

import { extractErrorObj, extractString, fallbackByStatus, tryParseJson } from '@/model/http/providers/errors';
import type { ProviderErrorInfo } from '@/model/http/providers/types';

export function mapDeepSeekError(httpStatus: number, body: string): ProviderErrorInfo {
  const parsed = tryParseJson(body);
  const errorObj = extractErrorObj(parsed);

  const providerErrorCode = errorObj === null ? undefined : extractString(errorObj, 'code');
  const message = (errorObj === null ? undefined : extractString(errorObj, 'message')) ?? body;

  let gatewayStatusCode: number;
  let gatewayErrorCode: string;

  switch (httpStatus) {
    case 400: {
      gatewayStatusCode = 400;
      gatewayErrorCode = 'invalid_request';
      break;
    }
    case 401: {
      gatewayStatusCode = 401;
      gatewayErrorCode = 'authentication_error';
      break;
    }
    case 402: {
      gatewayStatusCode = 402;
      gatewayErrorCode = 'insufficient_balance';
      break;
    }
    case 422: {
      gatewayStatusCode = 422;
      gatewayErrorCode = 'invalid_parameter';
      break;
    }
    case 429: {
      gatewayStatusCode = 429;
      gatewayErrorCode = 'rate_limit_exceeded';
      break;
    }
    case 503: {
      gatewayStatusCode = 502;
      gatewayErrorCode = 'provider_unavailable';
      break;
    }
    default: {
      const fb = fallbackByStatus(httpStatus);
      gatewayStatusCode = fb.gatewayStatusCode;
      gatewayErrorCode = fb.gatewayErrorCode;
    }
  }

  return { gatewayStatusCode, gatewayErrorCode, providerErrorCode, message };
}
