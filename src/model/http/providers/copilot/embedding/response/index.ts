// src/providers/copilot/embedding/response/index.ts — Copilot 嵌入响应适配器

import type { ProviderEmbeddingResponseAdapter } from '@/model/http/providers/types';
import type { InternalEmbeddingResponse } from '@/types';
import { createLogger, logColors } from '@/utils';

const logger = createLogger('Provider:Copilot:Embedding', logColors.bold + logColors.cyan);

/**
 * Copilot 嵌入响应适配器
 * 将兼容 OpenAI 格式的 /v1/embeddings 响应转换为内部通用格式
 */
export class CopilotEmbeddingResponseAdapter implements ProviderEmbeddingResponseAdapter {
  public fromProviderResponse(providerRes: unknown): InternalEmbeddingResponse {
    logger.debug('Adapting Copilot embedding response to internal format');

    if (providerRes === undefined || providerRes === null || typeof providerRes !== 'object') {
      throw new Error('Invalid Copilot embedding response: not an object');
    }

    const res = providerRes as Record<string, unknown>;

    let usage: InternalEmbeddingResponse['usage'] = { prompt_tokens: 0, total_tokens: 0 };
    if (res.usage !== undefined && res.usage !== null && typeof res.usage === 'object') {
      const u = res.usage as Record<string, unknown>;
      usage = {
        prompt_tokens: typeof u.prompt_tokens === 'number' ? u.prompt_tokens : 0,
        total_tokens: typeof u.total_tokens === 'number' ? u.total_tokens : 0,
      };
    }

    let embedding: number[] | string = [];
    if (Array.isArray(res.data) && res.data.length > 0) {
      const firstObj: unknown = res.data[0];
      if (typeof firstObj === 'object' && firstObj !== null) {
        const item = firstObj as Record<string, unknown>;
        if (Array.isArray(item.embedding)) {
          embedding = item.embedding as number[];
        } else if (typeof item.embedding === 'string') {
          embedding = item.embedding;
        }
      }
    }

    return {
      object: 'embedding',
      embedding: embedding,
      usage,
    };
  }
}
