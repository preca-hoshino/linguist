// src/providers/copilot/chat/response/stream.ts — Copilot 流式响应适配器

import type { ProviderChatStreamResponseAdapter } from '@/providers/types';
import type { FinishReason, InternalChatStreamChunk, ToolCallDelta } from '@/types';
import type { CopilotUsage } from './types';

// ==================== Copilot 流式类型定义 ====================

interface CopilotStreamDelta {
  role?: string;
  content?: string;
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

interface CopilotStreamChoice {
  index: number;
  delta: CopilotStreamDelta;
  finish_reason: string | null;
}

interface CopilotStreamChunk {
  choices?: CopilotStreamChoice[];
  usage?: CopilotUsage;
}

// ==================== 适配器实现 ====================

/** 已知的 finish_reason 值集合 */
const KNOWN_REASONS = new Set<string>(['stop', 'length', 'tool_calls', 'content_filter']);

/**
 * 映射 finish_reason 到内部值
 * 未知值返回 null（避免下游误判为最终 chunk）
 */
function mapFinishReason(reason: string | null): FinishReason | null {
  if (reason === null || reason === '') {
    return null;
  }
  return KNOWN_REASONS.has(reason) ? (reason as FinishReason) : null;
}

/**
 * Copilot 流式响应适配器
 * Copilot SSE chunk → InternalChatStreamChunk
 *
 * Copilot 使用标准 OpenAI 流式格式，无 reasoning_content 扩展字段。
 */
export class CopilotChatStreamResponseAdapter implements ProviderChatStreamResponseAdapter {
  public fromProviderStreamChunk(providerChunk: unknown): InternalChatStreamChunk {
    const chunk = providerChunk as CopilotStreamChunk;

    return {
      choices: (chunk.choices ?? []).map((c) => ({
        index: c.index,
        delta: {
          role: c.delta.role === 'assistant' ? ('assistant' as const) : undefined,
          content: c.delta.content,
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
        finish_reason: mapFinishReason(c.finish_reason),
      })),
      usage: chunk.usage
        ? {
            prompt_tokens: chunk.usage.prompt_tokens,
            completion_tokens: chunk.usage.completion_tokens,
            total_tokens: chunk.usage.total_tokens,
          }
        : undefined,
    };
  }
}
