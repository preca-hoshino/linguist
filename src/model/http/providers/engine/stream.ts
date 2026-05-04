// src/model/http/providers/engine/stream.ts — 流式 SSE 解析与 chunk 生成

import type { InternalChatStreamChunk, RoutedModelHttpContext } from '@/types';
import { parseSSEStream } from '@/utils';
import type { ProviderChatStreamResponseAdapter } from '../types';
import { getProviderLogger } from './logger';

// ========== 流式 chunk 生成器 ==========

export async function* createChunkGenerator(
  ctx: RoutedModelHttpContext,
  response: globalThis.Response,
  streamResponseAdapter: ProviderChatStreamResponseAdapter,
): AsyncGenerator<InternalChatStreamChunk> {
  const providerLogger = getProviderLogger(ctx.route.providerKind);
  if (!response.body) {
    providerLogger.warn({ requestId: ctx.id }, 'Stream response has no body');
    return;
  }

  for await (const dataLine of parseSSEStream(response.body)) {
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
