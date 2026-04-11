// src/providers/chat/volcengine/response/index.ts — 火山引擎响应适配器（精简编排层）

import type { ProviderChatResponseAdapter } from '@/model/http/providers/types';
import type { FinishReason, InternalChatResponse } from '@/types';
import { createLogger, GatewayError, logColors } from '@/utils';
import type { VolcEngineResponse } from './types';

const logger = createLogger('Provider:VolcEngine', logColors.bold + logColors.magenta);

/**
 * 火山引擎聊天响应适配器
 * 火山引擎 API 响应 → InternalChatResponse
 *
 * 火山引擎响应与 OpenAI 兼容，主要差异：
 * - finish_reason 值映射（'error' → 'unknown'）
 * - reasoning_content 字段（深度思考模型）
 */
export class VolcEngineChatResponseAdapter implements ProviderChatResponseAdapter {
  public fromProviderResponse(providerRes: unknown): InternalChatResponse {
    if (providerRes === undefined || providerRes === null || typeof providerRes !== 'object') {
      throw new GatewayError(502, 'provider_response_invalid', 'VolcEngine response missing choices array');
    }
    const res = providerRes as VolcEngineResponse;
    if (!Array.isArray(res.choices)) {
      throw new GatewayError(502, 'provider_response_invalid', 'VolcEngine response missing choices array');
    }
    logger.debug(
      {
        choicesCount: res.choices.length,
        hasUsage: !!res.usage,
        totalTokens: res.usage?.total_tokens,
      },
      'Adapting VolcEngine response to internal format',
    );

    return {
      choices: res.choices.map((c) => ({
        index: c.index,
        message: {
          role: 'assistant' as const,
          content: c.message.content ?? null,
          reasoning_content: c.message.reasoning_content,
          tool_calls: c.message.tool_calls,
        },
        finish_reason: this.mapFinishReason(c.finish_reason),
      })),
      usage: res.usage
        ? {
            prompt_tokens: res.usage.prompt_tokens,
            completion_tokens: res.usage.completion_tokens,
            total_tokens: res.usage.total_tokens,
            reasoning_tokens: res.usage.completion_tokens_details?.reasoning_tokens,
            cached_tokens: res.usage.prompt_tokens_details?.cached_tokens,
          }
        : undefined,
    };
  }

  /** 已知的 finish_reason 值集合 */
  private static readonly KNOWN_REASONS = new Set<string>(['stop', 'length', 'tool_calls', 'content_filter']);

  /**
   * 映射火山引擎 finish_reason 到内部统一值
   * 火山引擎可能返回 'error'，统一映射为 'unknown'
   */
  private mapFinishReason(reason: string): FinishReason {
    return VolcEngineChatResponseAdapter.KNOWN_REASONS.has(reason) ? (reason as FinishReason) : 'unknown';
  }
}
