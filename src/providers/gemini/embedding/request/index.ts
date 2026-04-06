// src/providers/embedding/gemini/request/index.ts — Gemini 嵌入请求适配器

import type { ProviderEmbeddingRequestAdapter } from '@/providers/types';
import type { EmbeddingTextInput, InternalEmbeddingRequest } from '@/types';
import { createLogger, logColors } from '@/utils';

const logger = createLogger('Provider:Gemini:Embedding', logColors.bold + logColors.yellow);

/**
 * Gemini 嵌入请求适配器
 * InternalEmbeddingRequest + routedModel → Gemini embedContent 请求体
 *
 * Gemini 嵌入 API 仅支持纯文本。
 * 所有对接 Gemini 的用户端点（OpenAI / Gemini 格式）也仅产生 EmbeddingTextInput，
 * 因此 input 数组中的所有项均为文本，直接映射为 content.parts。
 *
 * 转换规则：
 * - 内部 input（EmbeddingTextInput[]）→ { content: { parts: [{ text }, ...] }, taskType?, outputDimensionality? }
 * - 内部 task → Gemini taskType（透传）
 * - 内部 dimensions → Gemini outputDimensionality
 */
export class GeminiEmbeddingRequestAdapter implements ProviderEmbeddingRequestAdapter {
  public toProviderRequest(internalReq: InternalEmbeddingRequest, routedModel: string): Record<string, unknown> {
    // 用户端点仅产生 EmbeddingTextInput，直接断言类型并映射为 Gemini parts
    const parts = (internalReq.input as EmbeddingTextInput[]).map((item) => ({ text: item.text }));

    logger.debug(
      {
        routedModel,
        dimensions: internalReq.dimensions,
        task: internalReq.task,
        partsCount: parts.length,
      },
      'Adapting internal embedding request to Gemini embedContent format',
    );

    // 注意：model 已通过 URL 路径传递（/v1beta/models/{model}:embedContent），请求体内不需要重复
    const req: Record<string, unknown> = {
      content: {
        parts,
      },
    };

    if (internalReq.task !== undefined) {
      req.taskType = internalReq.task;
    }
    if (internalReq.dimensions !== undefined) {
      req.outputDimensionality = internalReq.dimensions;
    }

    return req;
  }
}
