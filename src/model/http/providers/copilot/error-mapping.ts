// src/providers/copilot/error-mapping.ts — Copilot 错误映射
//
// Copilot 使用 OpenAI 兼容错误格式：
// { "error": { "message": "...", "type": "...", "code": "..." } }
// 额外处理 403（订阅权限）和 401（Token 过期）场景

import { extractErrorObj, extractString, fallbackByStatus, tryParseJson } from '@/model/http/providers/errors';
import type { ProviderErrorInfo } from '@/model/http/providers/types';

export function mapCopilotError(httpStatus: number, body: string): ProviderErrorInfo {
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
      // Copilot Token 过期或 access_token 无效
      gatewayStatusCode = 401;
      gatewayErrorCode = 'authentication_error';
      break;
    }
    case 403: {
      // Copilot 订阅未激活或无访问权限
      gatewayStatusCode = 403;
      gatewayErrorCode = 'permission_denied';
      break;
    }
    case 429: {
      // Copilot 速率限制
      gatewayStatusCode = 429;
      gatewayErrorCode = 'rate_limit_exceeded';
      break;
    }
    case 500: {
      gatewayStatusCode = 502;
      gatewayErrorCode = 'provider_error';
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
