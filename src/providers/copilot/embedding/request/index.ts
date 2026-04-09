// src/providers/copilot/embedding/request/index.ts — Copilot 嵌入请求适配器

import type { ProviderEmbeddingRequestAdapter } from '@/providers/types';
import type { InternalEmbeddingRequest } from '@/types';
import { createLogger, logColors } from '@/utils';

const logger = createLogger('Provider:Copilot:Embedding', logColors.bold + logColors.cyan);

/**
 * Copilot 嵌入请求适配器
 * 转换为兼容 OpenAI /v1/embeddings 格式的请求
 */
export class CopilotEmbeddingRequestAdapter implements ProviderEmbeddingRequestAdapter {
  public toProviderRequest(internalReq: InternalEmbeddingRequest, routedModel: string): Record<string, unknown> {
    logger.debug(
      { routedModel, inputsCount: internalReq.input.length },
      'Adapting internal embedding request to Copilot format',
    );

    const inputTexts: string[] = [];
    for (const item of internalReq.input) {
      if (item.type === 'text') {
        inputTexts.push(item.text);
      }
    }

    const req: Record<string, unknown> = {
      model: routedModel,
      input: inputTexts,
    };

    if (internalReq.encoding_format !== undefined) {
      req.encoding_format = internalReq.encoding_format;
    }

    if (internalReq.dimensions !== undefined) {
      req.dimensions = internalReq.dimensions;
    }

    return req;
  }
}
