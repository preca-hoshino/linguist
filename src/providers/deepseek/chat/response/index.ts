// src/providers/chat/deepseek/response/index.ts — DeepSeek 响应适配器（精简编排层）

import type { ProviderChatResponseAdapter } from '@/providers/types';
import type { FinishReason, InternalChatResponse } from '@/types';
import { createLogger, GatewayError, logColors } from '@/utils';
import type { DeepSeekResponse } from './types';

const logger = createLogger('Provider:DeepSeek', logColors.bold + logColors.green);

/**
 * DeepSeek 聊天响应适配器
 * DeepSeek API 响应 → InternalChatResponse
 *
 * DeepSeek 响应与 OpenAI 兼容，主要差异：
 * - reasoning_content 字段（思考过程）
 * - finish_reason 值映射
 */
export class DeepSeekChatResponseAdapter implements ProviderChatResponseAdapter {
  public fromProviderResponse(providerRes: unknown): InternalChatResponse {
    if (providerRes === undefined || providerRes === null || typeof providerRes !== 'object') {
      throw new GatewayError(502, 'provider_response_invalid', 'DeepSeek response missing choices array');
    }
    const res = providerRes as DeepSeekResponse;
    if (!Array.isArray(res.choices)) {
      throw new GatewayError(502, 'provider_response_invalid', 'DeepSeek response missing choices array');
    }
    logger.debug(
      {
        choicesCount: res.choices.length,
        hasUsage: !!res.usage,
        totalTokens: res.usage?.total_tokens,
      },
      'Adapting DeepSeek response to internal format',
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
            cached_tokens: res.usage.prompt_cache_hit_tokens,
          }
        : undefined,
    };
  }

  /** 已知的 finish_reason 值集合 */
  private static readonly KNOWN_REASONS = new Set<string>(['stop', 'length', 'tool_calls', 'content_filter']);

  /**
   * 映射 DeepSeek finish_reason 到内部统一值
   */
  private mapFinishReason(reason: string): FinishReason {
    return DeepSeekChatResponseAdapter.KNOWN_REASONS.has(reason) ? (reason as FinishReason) : 'unknown';
  }
}
