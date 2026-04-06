// src/users/gemini/chat/response/index.ts — Gemini 响应适配器（精简编排层）

import type { GatewayContext, InternalChatResponse } from '@/types';
import type { UserChatResponseAdapter } from '@/users/types';
import { createLogger, logColors } from '@/utils';
import { convertCandidate } from './candidate-converter';
import { convertUsage } from './usage-converter';

const logger = createLogger('User:Gemini', logColors.bold + logColors.blue);

/**
 * 从 GatewayContext 组装 Gemini 原生格式聊天响应
 *
 * 核心转换逻辑：
 * - choices[].message.content → candidates[].content.parts[{ text }]
 * - choices[].message.tool_calls → candidates[].content.parts[{ functionCall }]
 * - choices[].message.reasoning_content → candidates[].content.parts[{ text, thought: true }]
 * - finish_reason → finishReason (stop→STOP, length→MAX_TOKENS, content_filter→SAFETY)
 * - usage → usageMetadata (prompt_tokens→promptTokenCount, etc.)
 * - id/model/created 从 ctx 获取
 */
export class GeminiChatResponseAdapter implements UserChatResponseAdapter {
  public fromInternal(ctx: GatewayContext): Record<string, unknown> {
    const res = ctx.response as InternalChatResponse;

    logger.debug(
      {
        requestId: ctx.id,
        choicesCount: res.choices.length,
        hasUsage: !!res.usage,
        model: ctx.requestModel,
      },
      'Converting internal response to Gemini format',
    );

    return {
      candidates: res.choices.map((choice) => convertCandidate(choice)),
      usageMetadata: convertUsage(res.usage),
      modelVersion: ctx.requestModel,
    };
  }
}
