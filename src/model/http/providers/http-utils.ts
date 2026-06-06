// src/providers/http-utils.ts — HTTP 响应统一处理工具 (解耦版)

import { extractErrorObj, extractString } from '@/model/http/providers/errors';
import { GatewayError } from '@/utils';
import type { Logger } from '@/utils/logger';
import type { ProviderErrorInfo } from './types';

/** 将 fetch Headers 转为普通对象 */
export function fetchHeadersToRecord(headers: globalThis.Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    result[key] = value;
  }
  return result;
}

/**
 * 从已解析的 JSON 响应体中检测 OpenAI 格式的错误
 *
 * 某些代理部署（如 one-api、new-api）会在 HTTP 200 下返回：
 * `{ "error": { "message": "...", "type": "...", "code": "..." } }`
 * 而不是标准的 chat completion 响应（带 choices/candidates/data）。
 *
 * 检测策略：存在 error 属性 + 不存在任何已知成功字段 → 判定为上游错误
 */
function detectUpstreamError(body: unknown): string | null {
  if (body === null || body === undefined || typeof body !== 'object') {
    return null;
  }
  const obj = body as Record<string, unknown>;

  // 必须包含 error 属性
  const errorObj = extractErrorObj(obj);
  if (errorObj === null) {
    return null;
  }

  // 不应包含任何已知的成功响应字段（避免误判正常响应）
  if ('choices' in obj || 'candidates' in obj || 'data' in obj || 'embedding' in obj) {
    return null;
  }

  return extractString(errorObj, 'message') ?? null;
}

/**
 * 统一处理提供商 HTTP 响应
 * 注意：不再从 index 动态加载插件，而是由调用方（Client）显式传入对应厂商的 mapError 函数。
 * 这样做可以打破循环依赖，并提高测试环境的稳定性。
 *
 * 容错处理：
 * - HTTP 非 2xx → 使用 mapError 映射并抛出 GatewayError
 * - HTTP 200 但 body 含 error 对象（one-api 常见行为）→ 提取错误消息并抛出 GatewayError
 */
export async function parseProviderResponse(
  response: globalThis.Response,
  providerName: string,
  providerLogger: Logger,
  meta: { duration: number; model?: string },
  mapError: (status: number, body: string) => ProviderErrorInfo,
): Promise<{ body: unknown; statusCode: number; responseHeaders: Record<string, string> }> {
  providerLogger.debug({ status: response.status, ok: response.ok, ...meta }, `${providerName} API response received`);
  if (!response.ok) {
    const errorBody = await response.text();
    providerLogger.error({ status: response.status, body: errorBody, ...meta }, `${providerName} API error`);

    const errorInfo = mapError(response.status, errorBody);

    throw new GatewayError(
      errorInfo.gatewayStatusCode,
      errorInfo.gatewayErrorCode,
      `${providerName} API returned ${String(response.status)}: ${errorInfo.message}`,
      {
        statusCode: response.status,
        errorCode: errorInfo.providerErrorCode,
        rawBody: errorBody,
      },
    );
  }
  providerLogger.debug({ status: response.status, ...meta }, `${providerName} API call succeeded`);
  const body = await response.json();

  // 检测上游是否在 HTTP 200 下返回了错误响应体（one-api/new-api 常见行为）
  const upstreamError = detectUpstreamError(body);
  if (upstreamError !== null) {
    providerLogger.warn({ upstreamError, ...meta }, `${providerName} returned error in 200 OK response body`);
    throw new GatewayError(502, 'provider_error', `${providerName} API error: ${upstreamError}`);
  }

  const statusCode = response.status;
  const responseHeaders = fetchHeadersToRecord(response.headers);
  return { body, statusCode, responseHeaders };
}
