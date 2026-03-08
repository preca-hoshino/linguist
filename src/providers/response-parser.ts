// src/providers/response-parser.ts — 提供商 HTTP 响应统一处理

import { GatewayError } from '../utils/errors';
import { mapProviderError } from './error-mapping';
import type { Logger } from '../utils/logger';

/**
 * 将 fetch Headers 转为普通对象
 */
export function fetchHeadersToRecord(headers: globalThis.Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

/**
 * 统一处理提供商 HTTP 响应
 * 检查响应状态码，非 2xx 时通过提供商错误映射抛出 GatewayError（含 providerDetail），
 * 成功时解析 JSON 并返回响应头
 *
 * @param response fetch 返回的 Response 对象
 * @param providerKind 提供商标识（如 'deepseek'、'gemini'、'volcengine'）
 * @param providerName 提供商显示名称（用于日志）
 * @param providerLogger 提供商专属日志器
 * @param meta 额外元数据（duration, model 等）
 * @returns 解析后的 JSON body + 响应头
 */
export async function parseProviderResponse(
  response: globalThis.Response,
  providerKind: string,
  providerName: string,
  providerLogger: Logger,
  meta: { duration: number; model?: string },
): Promise<{ body: unknown; responseHeaders: Record<string, string> }> {
  if (!response.ok) {
    const errorBody = await response.text();
    providerLogger.error({ status: response.status, body: errorBody, ...meta }, `${providerName} API error`);
    const errorInfo = mapProviderError(providerKind, response.status, errorBody);
    throw new GatewayError(
      errorInfo.gatewayStatusCode,
      errorInfo.gatewayErrorCode,
      `${providerName} API returned ${String(response.status)}: ${errorInfo.message}`,
      { statusCode: response.status, errorCode: errorInfo.providerErrorCode, rawBody: errorBody },
    );
  }
  providerLogger.debug({ status: response.status, ...meta }, `${providerName} API call succeeded`);
  const body = await response.json();
  const responseHeaders = fetchHeadersToRecord(response.headers);
  return { body, responseHeaders };
}
