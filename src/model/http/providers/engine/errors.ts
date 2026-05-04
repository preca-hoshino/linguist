// src/model/http/providers/engine/errors.ts — 错误消息脱敏与错误处理

import { GatewayError } from '@/utils';
import type { RoutedModelHttpContext } from '@/types';

// ========== 错误消息脱敏 ==========

export function sanitizeProviderError(detail: string): string {
  const stripped = detail.replace(/^\w[\w\s]* API returned \d+:\s*/i, '');
  return stripped.length > 0 ? stripped : 'Provider request failed';
}

// ========== 统一错误处理 ==========

/**
 * 将 provider 调用异常统一转换为 GatewayError，
 * 同时记录 providerDetail 到 ctx 供审计使用。
 */
export function handleProviderError(
  error: unknown,
  ctx: RoutedModelHttpContext,
  label: string,
  providerLogger: { warn: (obj: Record<string, unknown>, msg: string) => void },
): never {
  const detail = error instanceof Error ? error.message : String(error);
  providerLogger.warn(
    { requestId: ctx.id, model: ctx.route.model, strategy: ctx.route.strategy, error: detail },
    `${ctx.route.strategy}: ${label.toLowerCase()} provider call failed`,
  );

  if (error instanceof GatewayError && error.providerDetail !== undefined) {
    ctx.providerError = error.providerDetail;
  }

  const sanitizedMessage = sanitizeProviderError(detail);

  if (error instanceof Error && error.name === 'TimeoutError') {
    throw new GatewayError(504, 'provider_timeout', 'Provider request timed out');
  }

  if (error instanceof GatewayError) {
    throw new GatewayError(error.statusCode, error.errorCode, sanitizedMessage);
  }
  throw new GatewayError(502, 'provider_error', sanitizedMessage);
}
