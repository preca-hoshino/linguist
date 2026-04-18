// src/providers/embedding/gemini/response/index.ts — Gemini 嵌入响应适配器

import type { ProviderEmbeddingResponseAdapter } from '@/model/http/providers/types';
import type { InternalEmbeddingResponse } from '@/types';
import { createLogger, GatewayError, logColors } from '@/utils';

const logger = createLogger('Provider:Gemini:Embedding', logColors.bold + logColors.yellow);

/**
 * Gemini embedContent 响应格式
 */
interface GeminiEmbedContentResponse {
  embedding: { values: number[] };
}

/**
 * Gemini 嵌入响应适配器
 * Gemini embedContent 响应 → InternalEmbeddingResponse
 *
 * Gemini 响应特点：
 * - embedContent 返回 { embedding: { values: [...] } }
 * - 不包含 usage 信息
 * - 不包含 id / model / created（由 ModelHttpContext 管理）
 */
export class GeminiEmbeddingResponseAdapter implements ProviderEmbeddingResponseAdapter {
  public fromProviderResponse(providerRes: unknown): InternalEmbeddingResponse {
    if (providerRes === undefined || providerRes === null || typeof providerRes !== 'object') {
      throw new GatewayError(502, 'provider_response_invalid', 'Gemini embedding response missing embedding object');
    }
    const res = providerRes as GeminiEmbedContentResponse;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 防御性校验：providerRes 来自外部，实际类型不可信
    if (res.embedding === undefined || res.embedding === null || typeof res.embedding !== 'object') {
      throw new GatewayError(502, 'provider_response_invalid', 'Gemini embedding response missing embedding object');
    }

    if (!Array.isArray(res.embedding.values)) {
      throw new GatewayError(502, 'provider_response_invalid', 'Gemini embedding response missing values array');
    }

    logger.debug({ dims: res.embedding.values.length }, 'Adapting Gemini embedContent response to internal format');

    return {
      object: 'embedding',
      embedding: res.embedding.values,
    };
  }
}
