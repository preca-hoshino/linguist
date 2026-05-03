// src/providers/mimo/chat/response/stream.ts — MiMo 流式响应适配器

import type { ProviderChatStreamResponseAdapter } from '@/model/http/providers/types';
import type { FinishReason, InternalChatStreamChunk, ToolCallDelta } from '@/types';
import type { MiMoUsage } from './types';

// ==================== MiMo 流式类型 ====================

interface MiMoStreamDelta {
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
  /** 联网搜索引用注释（MiMo 特有，当前丢弃） */
  annotations?: unknown[];
  /** 内容审核错误信息 */
  error_message?: string;
  /** 音频响应 chunk（TTS 模型，当前丢弃） */
  audio?: unknown;
}

interface MiMoStreamChoice {
  index: number;
  delta: MiMoStreamDelta;
  finish_reason: string | null;
}

interface MiMoStreamChunk {
  choices?: MiMoStreamChoice[];
  usage?: MiMoUsage;
}

// ==================== 适配器实现 ====================

export class MiMoChatStreamResponseAdapter implements ProviderChatStreamResponseAdapter {
  /** 已知的 finish_reason 值集合 */
  private static readonly KNOWN_REASONS = new Set<string>([
    'stop',
    'length',
    'tool_calls',
    'content_filter',
    'repetition_truncation',
  ]);

  public fromProviderStreamChunk(providerChunk: unknown): InternalChatStreamChunk {
    const chunk = providerChunk as MiMoStreamChunk;

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
            cached_tokens: chunk.usage.prompt_tokens_details?.cached_tokens,
          }
        : undefined,
    };
  }

  private mapFinishReason(reason: string | null): FinishReason | null {
    if (reason === null || reason === '' || reason === undefined) {
      return null;
    }
    if (MiMoChatStreamResponseAdapter.KNOWN_REASONS.has(reason)) {
      return reason as FinishReason;
    }
    // 未知原因统一为 'stop'
    return 'stop';
  }
}
