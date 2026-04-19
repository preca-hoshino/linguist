// src/providers/http-utils.ts — HTTP 响应统一处理工具 (解耦版)

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
 * 统一处理提供商 HTTP 响应
 * 注意：不再从 index 动态加载插件，而是由调用方（Client）显式传入对应厂商的 mapError 函数。
 * 这样做可以打破循环依赖，并提高测试环境的稳定性。
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
  const statusCode = response.status;
  const responseHeaders = fetchHeadersToRecord(response.headers);
  return { body, statusCode, responseHeaders };
}
