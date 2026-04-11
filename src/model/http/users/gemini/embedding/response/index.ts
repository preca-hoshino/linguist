// src/users/gemini/embedding/response/index.ts — Gemini 嵌入响应适配器

import type { GatewayContext, InternalEmbeddingResponse } from '@/types';
import type { UserEmbeddingResponseAdapter } from '@/model/http/users/types';
import { createLogger, logColors } from '@/utils';

const logger = createLogger('User:Gemini:Embedding', logColors.bold + logColors.blue);

/**
 * 从 GatewayContext 组装 Gemini 原生格式嵌入响应
 *
 * embedContent 单条格式：{ embedding: { values: [...] } }
 */
export class GeminiEmbeddingResponseAdapter implements UserEmbeddingResponseAdapter {
  public fromInternal(ctx: GatewayContext): Record<string, unknown> {
    const res = ctx.response as InternalEmbeddingResponse;

    logger.debug(
      {
        requestId: ctx.id,
        model: ctx.requestModel,
      },
      'Converting internal embedding response to Gemini embedContent format',
    );

    return {
      embedding: {
        values: res.embedding,
      },
    };
  }
}
