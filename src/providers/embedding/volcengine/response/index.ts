// src/providers/embedding/volcengine/response/index.ts — 火山引擎嵌入响应适配器

import type { ProviderEmbeddingResponseAdapter } from '../../interface';
import type { InternalEmbeddingResponse, SparseEmbeddingElement } from '../../../../types';
import { createLogger, logColors, GatewayError } from '../../../../utils';

const logger = createLogger('Provider:VolcEngine:Embedding', logColors.bold + logColors.magenta);

/**
 * 火山引擎多模态嵌入响应对象
 *
 * 注意：单输入时 data 字段将返回对象，批量模式返回数组，统一取第一条。
 */
interface VolcEngineEmbeddingResponse {
  id: string;
  object: string;
  data: VolcEngineEmbeddingData | VolcEngineEmbeddingData[];
  model: string;
  created: number;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: {
      text_tokens?: number;
      image_tokens?: number;
      video_tokens?: number;
    };
  };
}

interface VolcEngineEmbeddingData {
  object: string;
  embedding: number[] | string;
  index: number;
  sparse_embedding?: { index: number; value: number }[];
}

/**
 * 火山引擎多模态嵌入响应适配器
 * 火山引擎 API 响应 → InternalEmbeddingResponse
 *
 * 主要处理：
 * - data 字段可能为单个对象或数组，统一归一化为数组
 * - sparse_embedding 可选字段的映射
 * - usage.prompt_tokens_details 的映射
 */
export class VolcEngineEmbeddingResponseAdapter implements ProviderEmbeddingResponseAdapter {
  public fromProviderResponse(providerRes: unknown): InternalEmbeddingResponse {
    const res = providerRes as VolcEngineEmbeddingResponse;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (typeof res !== 'object' || res === null) {
      throw new GatewayError(502, 'provider_response_invalid', 'VolcEngine embedding response missing data field');
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!Array.isArray(res.data) && (typeof res.data !== 'object' || res.data === null)) {
      throw new GatewayError(502, 'provider_response_invalid', 'VolcEngine embedding response missing data field');
    }

    // 取第一条结果（每次请求只处理单条输入）
    const firstItem = Array.isArray(res.data) ? res.data[0] : res.data;

    if (firstItem === undefined) {
      throw new GatewayError(502, 'provider_response_invalid', 'VolcEngine embedding response data is empty');
    }

    logger.debug({ totalTokens: res.usage.total_tokens }, 'Adapting VolcEngine embedding response to internal format');

    const result: InternalEmbeddingResponse = {
      object: 'embedding',
      embedding: firstItem.embedding,
    };

    // 映射稀疏向量（可选）
    if (firstItem.sparse_embedding !== undefined && firstItem.sparse_embedding.length > 0) {
      result.sparse_embedding = firstItem.sparse_embedding.map(
        (se): SparseEmbeddingElement => ({
          index: se.index,
          value: se.value,
        }),
      );
    }

    result.usage = {
      prompt_tokens: res.usage.prompt_tokens,
      total_tokens: res.usage.total_tokens,
      prompt_tokens_details:
        res.usage.prompt_tokens_details !== undefined
          ? {
              text_tokens: res.usage.prompt_tokens_details.text_tokens,
              image_tokens: res.usage.prompt_tokens_details.image_tokens,
              video_tokens: res.usage.prompt_tokens_details.video_tokens,
            }
          : undefined,
    };

    return result;
  }
}
