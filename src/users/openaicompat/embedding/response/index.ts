// src/users/openaicompat/embedding/response/index.ts — OpenAI 兼容嵌入响应适配器

import type { GatewayContext, InternalEmbeddingResponse } from '@/types';
import type { UserEmbeddingResponseAdapter } from '@/users/types';
import { createLogger, logColors } from '@/utils';

const logger = createLogger('User:OpenAICompat:Embedding', logColors.bold + logColors.cyan);

/**
 * 从 GatewayContext 组装 OpenAI 格式嵌入响应
 *
 * OpenAI /v1/embeddings 响应格式：
 * {
 *   object: 'list',
 *   data: [{ object: 'embedding', embedding: [...], index: 0 }],
 *   model: string,
 *   usage: { prompt_tokens, total_tokens }
 * }
 *
 * model 从 ctx.requestModel 获取。
 * data 始终为单元素数组（每次请求只处理一条嵌入）。
 */
export class OpenAICompatEmbeddingResponseAdapter implements UserEmbeddingResponseAdapter {
  public fromInternal(ctx: GatewayContext): Record<string, unknown> {
    const res = ctx.response as InternalEmbeddingResponse;
    logger.debug(
      {
        requestId: ctx.id,
        hasUsage: !!res.usage,
        model: ctx.requestModel,
      },
      'Converting internal embedding response to OpenAI format',
    );

    return {
      object: 'list',
      data: [
        {
          object: 'embedding',
          embedding: res.embedding,
          index: 0,
        },
      ],
      model: ctx.requestModel,
      // 部分提供商（如 Gemini）不返回 usage，兜底为零值以保持 OpenAI 格式兼容
      usage: res.usage
        ? {
            prompt_tokens: res.usage.prompt_tokens,
            total_tokens: res.usage.total_tokens,
          }
        : {
            prompt_tokens: 0,
            total_tokens: 0,
          },
    };
  }
}
