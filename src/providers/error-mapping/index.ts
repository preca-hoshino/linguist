// src/providers/error-mapping/index.ts — 提供商错误映射入口

import { mapDeepSeekError } from './deepseek';
import { mapGeminiError } from './gemini';
import { mapVolcengineError } from './volcengine';
import { fallbackByStatus, tryParseJson, extractString, extractErrorObj } from './shared';
import type { ProviderErrorInfo } from './shared';

export type { ProviderErrorInfo } from './shared';

/** 通用回退：无专属映射的提供商使用 */
function mapGenericError(httpStatus: number, body: string): ProviderErrorInfo {
  const parsed = tryParseJson(body);
  const errorObj = extractErrorObj(parsed);

  const providerErrorCode = errorObj !== null ? extractString(errorObj, 'code') : undefined;
  const message = (errorObj !== null ? extractString(errorObj, 'message') : undefined) ?? body;
  const fb = fallbackByStatus(httpStatus);

  return { gatewayStatusCode: fb.gatewayStatusCode, gatewayErrorCode: fb.gatewayErrorCode, providerErrorCode, message };
}

/**
 * 将提供商错误响应映射为网关统一错误信息
 *
 * @param providerKind 提供商标识（如 "deepseek"、"gemini"、"volcengine"）
 * @param httpStatus   提供商返回的 HTTP 状态码
 * @param body         提供商返回的原始响应体（文本）
 * @returns 映射后的 ProviderErrorInfo
 */
export function mapProviderError(providerKind: string, httpStatus: number, body: string): ProviderErrorInfo {
  switch (providerKind) {
    case 'deepseek':
      return mapDeepSeekError(httpStatus, body);
    case 'volcengine':
      return mapVolcengineError(httpStatus, body);
    case 'gemini':
      return mapGeminiError(httpStatus, body);
    default:
      return mapGenericError(httpStatus, body);
  }
}
