// src/users/gemini/embedding/request/index.ts — Gemini 嵌入请求适配器

import type { EmbeddingTaskType, EmbeddingTextInput, InternalEmbeddingRequest } from '@/types';
import type { UserEmbeddingRequestAdapter } from '@/model/http/users/types';
import { createLogger, GatewayError, logColors } from '@/utils';
import type { GeminiEmbedContentBody } from './types';

const logger = createLogger('User:Gemini:Embedding', logColors.bold + logColors.blue);

/**
 * Gemini 原生格式嵌入请求 → InternalEmbeddingRequest
 *
 * 仅处理 embedContent（单条）格式：body 必须含 content 字段。
 */
export class GeminiEmbeddingRequestAdapter implements UserEmbeddingRequestAdapter {
  public toInternal(userReq: unknown): InternalEmbeddingRequest {
    const body = userReq as Record<string, unknown>;

    if (body.content === undefined || body.content === null) {
      throw new GatewayError(400, 'invalid_request', 'Gemini embedding request must include a "content" field');
    }

    return this.fromSingle(body as unknown as GeminiEmbedContentBody);
  }

  /**
   * embedContent 格式转换
   *
   * Gemini content.parts 支持多个文本 part，每个 part 映射为一个 EmbeddingTextInput，
   * 所有 part 合并生成一个嵌入向量。
   */
  private fromSingle(body: GeminiEmbedContentBody): InternalEmbeddingRequest {
    const input = this.extractTextInputs(body.content);

    logger.debug(
      {
        taskType: body.taskType,
        outputDimensionality: body.outputDimensionality,
        partsCount: input.length,
      },
      'Converting Gemini embedContent request to internal format',
    );

    return {
      input,
      dimensions: body.outputDimensionality,
      task: body.taskType as EmbeddingTaskType,
    };
  }

  /**
   * 从 Gemini content 对象提取所有文本 part
   *
   * content.parts 中每个含 text 字段的 part 映射为一个 EmbeddingTextInput。
   * Gemini 嵌入 API 仅支持纯文本。
   */
  private extractTextInputs(content: { parts: { text: string }[] }): EmbeddingTextInput[] {
    if (!Array.isArray(content.parts) || content.parts.length === 0) {
      throw new GatewayError(
        400,
        'invalid_content',
        'Gemini embedding content must include a parts array with at least one text part',
      );
    }

    const inputs: EmbeddingTextInput[] = [];
    for (const part of content.parts) {
      if (typeof part.text !== 'string') {
        throw new GatewayError(400, 'invalid_content', 'Gemini embedding content part must have a text field');
      }
      inputs.push({ type: 'text', text: part.text });
    }

    return inputs;
  }
}
