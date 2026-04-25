// src/providers/chat/deepseek/response/stream.ts — DeepSeek 流式响应适配器

import type { ProviderChatStreamResponseAdapter } from '@/model/http/providers/types';
import type { FinishReason, InternalChatStreamChunk, ToolCallDelta } from '@/types';
import type { DeepSeekUsage } from './types';

// ==================== DeepSeek 流式类型 ====================

interface DeepSeekStreamDelta {
  role?: string;
  content?: string;
  reasoning_content?: string;
  tool_calls?: {
    index: number;
    id?: string;
    type?: string;
    function?: {
      name?: string;
      arguments?: string;
    };
  }[];
}

interface DeepSeekStreamChoice {
  index: number;
  delta: DeepSeekStreamDelta;
  finish_reason: string | null;
}

interface DeepSeekStreamChunk {
  choices?: DeepSeekStreamChoice[];
  usage?: DeepSeekUsage;
}

// ==================== 适配器实现 ====================

export class DeepSeekChatStreamResponseAdapter implements ProviderChatStreamResponseAdapter {
  /** 已知的 finish_reason 值集合 */
  private static readonly KNOWN_REASONS = new Set<string>([
    'stop',
    'length',
    'tool_calls',
    'content_filter',
    'insufficient_system_resource',
  ]);

  public fromProviderStreamChunk(providerChunk: unknown): InternalChatStreamChunk {
    const chunk = providerChunk as DeepSeekStreamChunk;

    return {
      choices: (chunk.choices ?? []).map((c) => ({
        index: c.index,
        delta: {
          role: c.delta.role === 'assistant' ? ('assistant' as const) : undefined,
          content: c.delta.content,
          reasoning_content: c.delta.reasoning_content,
          tool_calls: c.delta.tool_calls?.map(
            (tc): ToolCallDelta => ({
              index: tc.index,
              id: tc.id,
              type: tc.type === 'function' ? 'function' : undefined,
              function: tc.function
                ? {
                    name: tc.function.name,
                    arguments: tc.function.arguments,
                  }
                : undefined,
            }),
          ),
        },
        finish_reason: this.mapFinishReason(c.finish_reason),
      })),
      usage: chunk.usage
        ? {
            prompt_tokens: chunk.usage.prompt_tokens,
            completion_tokens: chunk.usage.completion_tokens,
            total_tokens: chunk.usage.total_tokens,
            reasoning_tokens: chunk.usage.completion_tokens_details?.reasoning_tokens,
            cached_tokens: chunk.usage.prompt_cache_hit_tokens,
          }
        : undefined,
    };
  }

  private mapFinishReason(reason: string | null): FinishReason | null {
    if (reason === null || reason === '') {
      return null;
    }
    // 已知原因直接映射；未知但非空的原因统一为 'unknown'，
    // 与非流式适配器行为对齐，确保下游结束逻辑可正常触发
    return DeepSeekChatStreamResponseAdapter.KNOWN_REASONS.has(reason) ? (reason as FinishReason) : 'unknown';
  }
}
