// src/providers/chat/volcengine/response/stream.ts — 火山引擎流式响应适配器

import type { ProviderChatStreamResponseAdapter } from '@/providers/types';
import type { FinishReason, InternalChatStreamChunk, ToolCallDelta } from '@/types';
import type { VolcEngineUsage } from './types';

// ==================== 火山引擎流式类型 ====================

interface VolcEngineStreamDelta {
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

interface VolcEngineStreamChoice {
  index: number;
  delta: VolcEngineStreamDelta;
  finish_reason: string | null;
}

interface VolcEngineStreamChunk {
  choices?: VolcEngineStreamChoice[];
  usage?: VolcEngineUsage;
}

// ==================== 适配器实现 ====================

export class VolcEngineChatStreamResponseAdapter implements ProviderChatStreamResponseAdapter {
  /** 已知的 finish_reason 值集合 */
  private static readonly KNOWN_REASONS = new Set<string>(['stop', 'length', 'tool_calls', 'content_filter']);

  public fromProviderStreamChunk(providerChunk: unknown): InternalChatStreamChunk {
    const chunk = providerChunk as VolcEngineStreamChunk;

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
    if (reason === null || reason === '') {
      return null;
    }
    // 仅识别已知原因；未知值视为尚未结束（返回 null 而非 'unknown'），
    // 避免下游用户适配器误判为最终 chunk
    return VolcEngineChatStreamResponseAdapter.KNOWN_REASONS.has(reason) ? (reason as FinishReason) : null;
  }
}
