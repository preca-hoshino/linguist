// src/app/helpers.ts — 请求处理辅助函数

import type { Response } from 'express';
import type { ModelHttpContext, HttpHeaders } from '@/types';
import type { Logger } from '@/utils';

// ========== 生命周期收尾 Helpers ==========

/**
 * 成功收尾：记录 timing 并打印成功日志
 * 由调用方负责之后执行 markCompleted(ctx)
 */
export function finalizeSuccess(ctx: ModelHttpContext, label: string, logger: Logger): void {
  ctx.timing.end = Date.now();
  const totalDuration = ctx.timing.end - ctx.timing.start;
  const providerDuration =
    ctx.timing.providerStart !== undefined && ctx.timing.providerEnd !== undefined
      ? ctx.timing.providerEnd - ctx.timing.providerStart
      : undefined;
  const gatewayOverhead = providerDuration === undefined ? undefined : totalDuration - providerDuration;
  logger.info(
    {
      requestId: ctx.id,
      model: ctx.requestModel,
      routedModel: ctx.route?.model,
      provider: ctx.route?.providerKind,
      endpoint: ctx.http.path,
      ...(ctx.stream === true ? { stream: true } : {}),
      totalDuration: `${totalDuration}ms`,
      providerDuration: providerDuration === undefined ? 'N/A' : `${String(providerDuration)}ms`,
      gatewayOverhead: gatewayOverhead === undefined ? 'N/A' : `${String(gatewayOverhead)}ms`,
    },
    `${label} request fulfilled`,
  );
}

/**
 * 失败收尾：写入 ctx.error、记录 timing 并打印失败日志
 * 由调用方负责之后执行 markError(ctx, err)
 */
export function finalizeError(ctx: ModelHttpContext, err: unknown, label: string, logger: Logger): void {
  ctx.error = err instanceof Error ? err.message : String(err);
  ctx.timing.end = Date.now();
  const totalDuration = ctx.timing.end - ctx.timing.start;
  logger.warn(
    {
      requestId: ctx.id,
      model: ctx.requestModel,
      endpoint: ctx.http.path,
      ...(ctx.stream === true ? { stream: true } : {}),
      error: ctx.error,
      duration: `${totalDuration}ms`,
    },
    `${label} request failed`,
  );
}

// ========== 请求头脱敏 ==========

/** 需要脱敏的请求头名称（小写） */
const SENSITIVE_HEADERS = new Set(['authorization', 'x-api-key', 'cookie', 'x-goog-api-key']);

/**
 * 提取并脱敏请求头快照
 * 脱敏规则：敏感头仅保留前缀（前11位），其余完整保留
 */
/** 请求头值类型 */
type HeaderValue = string | string[] | undefined;

export function sanitizeHeaders(headers: Record<string, HeaderValue>): Record<string, HeaderValue> {
  const result: Record<string, HeaderValue> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.has(key.toLowerCase()) && typeof value === 'string') {
      result[key] = value.length > 11 ? `${value.slice(0, 11)}...` : value;
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * 将 Express OutgoingHttpHeaders 转为 HttpHeaders
 * 数值型头（如 Content-Length）转为字符串
 */
export function expressHeadersToRecord(headers: ReturnType<Response['getHeaders']>): HttpHeaders {
  const result: HttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    result[key] = typeof value === 'number' ? String(value) : value;
  }
  return result;
}
