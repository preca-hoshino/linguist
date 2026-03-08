// src/users/embedding/openaicompat/request/index.ts — OpenAI 兼容嵌入请求适配器

import type { UserEmbeddingRequestAdapter } from '../../interface';
import type { InternalEmbeddingRequest, EmbeddingTextInput } from '../../../../types';
import type { OpenAICompatEmbeddingRequestBody } from './types';
import { GatewayError, createLogger, logColors } from '../../../../utils';

const logger = createLogger('User:OpenAICompat:Embedding', logColors.bold + logColors.cyan);

/**
 * OpenAI 格式嵌入请求 → InternalEmbeddingRequest
 *
 * 仅支持单条字符串输入（input: string）。
 * 如需批量嵌入多条文本，请分多次独立请求。
 */
export class OpenAICompatEmbeddingRequestAdapter implements UserEmbeddingRequestAdapter {
  public toInternal(userReq: unknown): InternalEmbeddingRequest {
    const body = userReq as OpenAICompatEmbeddingRequestBody;

    const rawInput = (userReq as Record<string, unknown>)['input'];
    if (rawInput === undefined || rawInput === null) {
      throw new GatewayError(400, 'missing_input', 'Embedding request must include an input field');
    }

    if (Array.isArray(rawInput)) {
      throw new GatewayError(
        400,
        'batch_not_supported',
        'Batch embedding (array input) is not supported. Send one input string per request.',
      );
    }

    if (typeof rawInput !== 'string') {
      throw new GatewayError(400, 'invalid_input', 'Embedding input must be a string');
    }

    if (rawInput.length === 0) {
      throw new GatewayError(400, 'empty_input', 'Embedding input must not be empty');
    }

    logger.debug(
      { encodingFormat: body.encoding_format, dimensions: body.dimensions },
      'Converting OpenAICompat embedding request to internal format',
    );

    const input: EmbeddingTextInput[] = [{ type: 'text', text: rawInput }];

    return {
      input,
      encoding_format: body.encoding_format,
      dimensions: body.dimensions,
      user: body.user,
    };
  }
}
