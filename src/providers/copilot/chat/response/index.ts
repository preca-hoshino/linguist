// src/providers/copilot/chat/response/index.ts — Copilot 响应适配器

import type { ProviderChatResponseAdapter } from '@/providers/types';
import type { FinishReason, InternalChatResponse } from '@/types';
import { createLogger, GatewayError, logColors } from '@/utils';
import type { CopilotResponse } from './types';

const logger = createLogger('Provider:Copilot', logColors.bold + logColors.cyan);

/** 已知的 finish_reason 值集合 */
const KNOWN_REASONS = new Set<string>(['stop', 'length', 'tool_calls', 'content_filter']);

/**
 * 将 finish_reason 字符串映射到内部统一枚举值
 */
function mapFinishReason(reason: string): FinishReason {
  return KNOWN_REASONS.has(reason) ? (reason as FinishReason) : 'unknown';
}

/**
 * Copilot 聊天响应适配器
 * Copilot API 响应 → InternalChatResponse
 *
 * Copilot 与标准 OpenAI response 格式兼容：
 * - 无 reasoning_content（不支持思维链）
 * - 无 prompt_cache_hit_tokens 等扩展字段
 */
export class CopilotChatResponseAdapter implements ProviderChatResponseAdapter {
  public fromProviderResponse(providerRes: unknown): InternalChatResponse {
    if (providerRes === undefined || providerRes === null || typeof providerRes !== 'object') {
      throw new GatewayError(502, 'provider_response_invalid', 'Copilot response is not an object');
    }

    const res = providerRes as CopilotResponse;

    if (!Array.isArray(res.choices)) {
      throw new GatewayError(502, 'provider_response_invalid', 'Copilot response missing choices array');
    }

    logger.debug(
      {
        choicesCount: res.choices.length,
        hasUsage: !!res.usage,
        totalTokens: res.usage?.total_tokens,
      },
      'Adapting Copilot response to internal format',
    );

    return {
      choices: res.choices.map((c) => ({
        index: c.index,
        message: {
          role: 'assistant' as const,
          content: c.message.content ?? null,
          tool_calls: c.message.tool_calls,
        },
        finish_reason: mapFinishReason(c.finish_reason),
      })),
      usage: res.usage
        ? {
            prompt_tokens: res.usage.prompt_tokens,
            completion_tokens: res.usage.completion_tokens,
            total_tokens: res.usage.total_tokens,
          }
        : undefined,
    };
  }
}
