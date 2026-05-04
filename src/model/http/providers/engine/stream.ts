// src/model/http/providers/engine/stream.ts — 流式 SSE 解析与 chunk 生成

import type { InternalChatStreamChunk, RoutedModelHttpContext } from '@/types';
import { DEFAULT_PROVIDER_TIMEOUT, GatewayError, parseSSEStream } from '@/utils';
import type { ProviderChatStreamResponseAdapter } from '../types';
import { getProviderLogger } from './logger';

// ========== 流式 chunk 生成器 ==========

/**
 * 创建流式 chunk 异步生成器
 *
 * 超时策略（与 createChunkGenerator 调用的上游约定）：
 * - `timeoutMs` 仅约束首个 SSE chunk 到达前的等待时间
 * - 首 chunk 到达后取消超时定时器，后续流式传输无时间限制
 * - 超时时抛出 GatewayError(504, 'upstream_timeout', ...)
 *
 * @param timeoutMs 首 token 超时阈值（毫秒），默认 DEFAULT_PROVIDER_TIMEOUT
 */
export async function* createChunkGenerator(
  ctx: RoutedModelHttpContext,
  response: globalThis.Response,
  streamResponseAdapter: ProviderChatStreamResponseAdapter,
  timeoutMs?: number,
): AsyncGenerator<InternalChatStreamChunk> {
  const providerLogger = getProviderLogger(ctx.route.providerKind);
  if (!response.body) {
    providerLogger.warn({ requestId: ctx.id }, 'Stream response has no body');
    return;
  }

  const timeout = timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT;
  const controller = new AbortController();
  const timerId = setTimeout(() => {
    controller.abort();
  }, timeout);

  let firstChunk = true;

  try {
    for await (const dataLine of parseSSEStream(response.body, controller.signal)) {
      // 首 chunk 到达 → 取消超时，后续无限流式
      if (firstChunk) {
        clearTimeout(timerId);
        firstChunk = false;
      }

      try {
        const providerChunk = JSON.parse(dataLine) as unknown;
        yield streamResponseAdapter.fromProviderStreamChunk(providerChunk);
      } catch (error) {
        providerLogger.warn(
          { requestId: ctx.id, error: error instanceof Error ? error.message : String(error) },
          'Failed to parse stream chunk, skipping',
        );
      }
    }
  } finally {
    clearTimeout(timerId);
  }

  // 如果 parseSSEStream 因 abort signal 触发而提前退出（未收到任何 chunk），抛出超时错误
  if (firstChunk && controller.signal.aborted) {
    throw new GatewayError(504, 'upstream_timeout', `First token not received from upstream within ${timeout}ms`);
  }

  ctx.timing.providerEnd = Date.now();
  /* istanbul ignore next -- fallback safety */
  const providerDuration =
    ctx.timing.providerStart === undefined ? undefined : ctx.timing.providerEnd - ctx.timing.providerStart;
  providerLogger.debug(
    {
      requestId: ctx.id,
      model: ctx.route.model,
      duration:
        /* istanbul ignore next -- fallback safety */ providerDuration === undefined ? 'N/A' : `${providerDuration}ms`,
    },
    '[dispatch] upstream stream completed',
  );
}
