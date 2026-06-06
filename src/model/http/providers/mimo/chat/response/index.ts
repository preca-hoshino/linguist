// src/providers/mimo/chat/response/index.ts — MiMo 响应适配器

import type { ProviderChatResponseAdapter } from '@/model/http/providers/types';
import type { FinishReason, InternalChatResponse } from '@/types';
import { createLogger, GatewayError, logColors } from '@/utils';
import type { MiMoResponse } from './types';

const logger = createLogger('Provider:MiMo', logColors.bold + logColors.blue);

/**
 * MiMo 聊天响应适配器
 * MiMo API 响应 → InternalChatResponse
 *
 * MiMo 响应与 OpenAI 兼容，主要差异：
 * - reasoning_content 字段（深度思考过程）
 * - annotations 字段（联网搜索引用，当前丢弃）
 * - audio 字段（TTS 音频，当前丢弃）
 * - finish_reason: 含独有的 'repetition_truncation'
 * - usage: 含 web_search_usage、prompt_tokens_details
 */
export class MiMoChatResponseAdapter implements ProviderChatResponseAdapter {
  /** 已知的 finish_reason 值集合 */
  private static readonly KNOWN_REASONS = new Set<string>([
    'stop',
    'length',
    'tool_calls',
    'content_filter',
    'repetition_truncation',
  ]);

  public fromProviderResponse(providerRes: unknown): InternalChatResponse {
    if (providerRes === undefined || providerRes === null || typeof providerRes !== 'object') {
      throw new GatewayError(502, 'provider_response_invalid', 'MiMo response missing choices array');
    }
    const res = providerRes as MiMoResponse;
    if (!Array.isArray(res.choices) || res.choices.length === 0) {
      throw new GatewayError(502, 'provider_response_invalid', 'MiMo response missing or empty choices array');
    }
    logger.debug(
      {
        choicesCount: res.choices.length,
        hasUsage: !!res.usage,
        totalTokens: res.usage?.total_tokens,
      },
      'Adapting MiMo response to internal format',
    );

    return {
      choices: res.choices.map((c) => ({
        index: c.index,
        message: {
          role: 'assistant' as const,
          content: c.message.content ?? null,
          // 思考内容透传
          reasoning_content: c.message.reasoning_content,
          // 工具调用透传
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

  /**
   * 映射 MiMo finish_reason 到内部统一值
   */
  private mapFinishReason(reason: string): FinishReason {
    if (MiMoChatResponseAdapter.KNOWN_REASONS.has(reason)) {
      return reason as FinishReason;
    }
    // 未知但非空的原因统一为 'stop'（MiMo 文档未列出的原因视为正常停止）
    return 'stop';
  }
}
