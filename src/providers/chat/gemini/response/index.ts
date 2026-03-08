// src/providers/chat/gemini/response/index.ts — Gemini 响应适配器（精简编排层）

import type { ProviderChatResponseAdapter } from '../../interface';
import type { InternalChatResponse } from '../../../../types';
import type { GeminiResponse } from './types';
import { convertCandidate } from './candidate-converter';
import { convertUsage } from './usage-converter';
import { createLogger, logColors, GatewayError } from '../../../../utils';

const logger = createLogger('Provider:Gemini', logColors.bold + logColors.yellow);

/**
 * Gemini 聊天响应适配器
 * Gemini generateContent 响应 → InternalChatResponse
 *
 * 核心转换逻辑：
 * - candidates[].content.parts → 文本拼接 + functionCall 提取 + thought 提取
 * - finishReason 值映射（STOP→stop, MAX_TOKENS→length 等）
 * - usageMetadata → usage 标准化
 * - functionCall parts → tool_calls[]
 * - thought parts → reasoning_content
 */
export class GeminiChatResponseAdapter implements ProviderChatResponseAdapter {
  public fromProviderResponse(providerRes: unknown): InternalChatResponse {
    const res = providerRes as GeminiResponse;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (typeof res !== 'object' || res === null) {
      throw new GatewayError(502, 'provider_response_invalid', 'Gemini response is not a valid object');
    }

    logger.debug(
      {
        candidatesCount: res.candidates?.length ?? 0,
        hasUsage: !!res.usageMetadata,
        totalTokens: res.usageMetadata?.totalTokenCount,
      },
      'Adapting Gemini response to internal format',
    );

    const candidates = res.candidates ?? [];

    return {
      choices: candidates.map((candidate, idx) => convertCandidate(candidate, idx)),
      usage: convertUsage(res.usageMetadata),
    };
  }
}
