// src/providers/mimo/error-mapping.ts — 小米 MiMo 错误映射
//
// MiMo 使用 OpenAI 兼容错误格式（推断）：
// { "error": { "message": "...", "type": "...", "code": "..." } }
// 同时依赖 HTTP 状态码区分错误类型，含独有 421 content_filtered

import { extractErrorObj, extractString, fallbackByStatus, tryParseJson } from '@/model/http/providers/errors';
import type { ProviderErrorInfo } from '@/model/http/providers/types';

export function mapMimoError(httpStatus: number, body: string): ProviderErrorInfo {
  const parsed = tryParseJson(body);
  const errorObj = extractErrorObj(parsed);

  const providerErrorCode = errorObj === null ? undefined : extractString(errorObj, 'code');
  const message = (errorObj === null ? undefined : extractString(errorObj, 'message')) ?? body;

  let gatewayStatusCode: number;
  let gatewayErrorCode: string;

  switch (httpStatus) {
    // 400 - 请求体格式错误（参数值不在有效范围、模型不存在、消息格式错误等）
    case 400: {
      gatewayStatusCode = 400;
      // 若消息表明是模型不存在，映射为 model_not_found
      if (/model.*(not found|not exist|unknown|invalid)/i.test(message)) {
        gatewayErrorCode = 'model_not_found';
      } else {
        gatewayErrorCode = 'invalid_request';
      }
      break;
    }
    // 401 - 缺少或无效的 API Key，或 Authorization 请求头格式错误
    case 401: {
      gatewayStatusCode = 401;
      gatewayErrorCode = 'authentication_error';
      break;
    }
    // 402 - 账户余额不足
    case 402: {
      gatewayStatusCode = 402;
      gatewayErrorCode = 'insufficient_balance';
      break;
    }
    // 403 - 服务暂不支持当前地区，或 API Key 被风控
    case 403: {
      gatewayStatusCode = 403;
      gatewayErrorCode = 'permission_denied';
      break;
    }
    // 421 - 内容审核拦截（MiMo 特有状态码）
    case 421: {
      gatewayStatusCode = 400;
      gatewayErrorCode = 'content_filtered';
      break;
    }
    // 429 - 请求过于频繁，或 Token Plan 额度耗尽
    case 429: {
      gatewayStatusCode = 429;
      gatewayErrorCode = 'rate_limit_exceeded';
      break;
    }
    // 500 - 服务器内部故障
    case 500: {
      gatewayStatusCode = 502;
      gatewayErrorCode = 'provider_error';
      break;
    }
    // 503 - 服务器负载过高
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
