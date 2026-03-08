// src/providers/error-mapping/gemini.ts — Gemini 错误映射
//
// Gemini 使用 gRPC 风格错误格式：
// { "error": { "code": 429, "message": "...", "status": "RESOURCE_EXHAUSTED" } }

import type { ProviderErrorInfo } from './shared';
import { tryParseJson, fallbackByStatus, extractString, extractErrorObj } from './shared';

/** Gemini gRPC status → 网关错误码 */
const GEMINI_STATUS_MAP: Record<string, string> = {
  INVALID_ARGUMENT: 'invalid_request',
  FAILED_PRECONDITION: 'invalid_request',
  PERMISSION_DENIED: 'permission_denied',
  NOT_FOUND: 'model_not_found',
  RESOURCE_EXHAUSTED: 'rate_limit_exceeded',
  INTERNAL: 'provider_error',
  UNAVAILABLE: 'provider_unavailable',
  DEADLINE_EXCEEDED: 'provider_timeout',
};

export function mapGeminiError(httpStatus: number, body: string): ProviderErrorInfo {
  const parsed = tryParseJson(body);
  const errorObj = extractErrorObj(parsed);

  const providerErrorCode = errorObj !== null ? extractString(errorObj, 'status') : undefined;
  const message = (errorObj !== null ? extractString(errorObj, 'message') : undefined) ?? body;

  if (providerErrorCode !== undefined && GEMINI_STATUS_MAP[providerErrorCode] !== undefined) {
    const fb = fallbackByStatus(httpStatus);
    return {
      gatewayStatusCode: fb.gatewayStatusCode,
      gatewayErrorCode: GEMINI_STATUS_MAP[providerErrorCode],
      providerErrorCode,
      message,
    };
  }

  const fb = fallbackByStatus(httpStatus);
  return { gatewayStatusCode: fb.gatewayStatusCode, gatewayErrorCode: fb.gatewayErrorCode, providerErrorCode, message };
}
