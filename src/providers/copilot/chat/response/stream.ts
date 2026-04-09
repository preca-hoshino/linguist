// src/providers/copilot/chat/response/stream.ts — Copilot 流式响应适配器（有状态 + 自识别端点）

import type { ProviderChatStreamResponseAdapter } from '@/providers/types';
import type { FinishReason, InternalChatStreamChunk, ToolCallDelta } from '@/types';
import { createAnthropicStreamState, parseAnthropicStreamChunk } from '../fallback/messages';
import { createResponsesStreamState, parseResponsesStreamChunk } from '../fallback/responses';
import type { AnthropicStreamState, CopilotEndpointType, ResponsesStreamState } from '../fallback/types';
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
 * 解析标准 OpenAI 流式 chunk（原有逻辑）
 */
function parseOpenAIChunk(chunk: Record<string, unknown>): InternalChatStreamChunk {
  const c = chunk as CopilotStreamChunk;
  return {
    choices: (c.choices ?? []).map((choice) => ({
      index: choice.index,
      delta: {
        role: choice.delta.role === 'assistant' ? ('assistant' as const) : undefined,
        content: choice.delta.content,
        tool_calls: choice.delta.tool_calls?.map(
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
      finish_reason: mapFinishReason(choice.finish_reason),
    })),
    usage: c.usage
      ? {
          prompt_tokens: c.usage.prompt_tokens,
          completion_tokens: c.usage.completion_tokens,
          total_tokens: c.usage.total_tokens,
        }
      : undefined,
  };
}

/**
 * 通过首个 chunk 的数据结构自动识别端点类型
 *
 * 三种协议的 SSE 数据结构天然互斥：
 * - OpenAI:    有 choices 字段
 * - Anthropic: type === 'message_start'
 * - Responses: type 以 'response.' 开头
 */
function detectEndpointFromChunk(chunk: Record<string, unknown>): CopilotEndpointType {
  if ('choices' in chunk) {
    return 'chat-completions';
  }
  if (chunk.type === 'message_start') {
    return 'messages';
  }
  if (typeof chunk.type === 'string' && chunk.type.startsWith('response.')) {
    return 'responses';
  }
  return 'chat-completions'; // 安全回退
}

/**
 * Copilot 流式响应适配器（有状态实例）
 *
 * 每次 getChatAdapterSet() 调用会返回新实例，保证不同请求间状态隔离。
 *
 * 端点类型识别策略：
 * - 不依赖注入的 endpointType（engine 管线约束下无法提前传递）
 * - 通过首个 SSE chunk 的结构特征自动推断（三协议结构天然互斥，零错误风险）
 */
export class CopilotChatStreamResponseAdapter implements ProviderChatStreamResponseAdapter {
  private endpointType: CopilotEndpointType | null = null;
  private anthropicState: AnthropicStreamState | undefined;
  private responsesState: ResponsesStreamState | undefined;

  public fromProviderStreamChunk(providerChunk: unknown): InternalChatStreamChunk {
    const chunk = providerChunk as Record<string, unknown>;

    // 首个 chunk：自识别端点类型并惰性初始化状态机
    this.endpointType ??= detectEndpointFromChunk(chunk);

    switch (this.endpointType) {
      case 'messages': {
        this.anthropicState ??= createAnthropicStreamState();
        return parseAnthropicStreamChunk(chunk, this.anthropicState);
      }
      case 'responses': {
        this.responsesState ??= createResponsesStreamState();
        return parseResponsesStreamChunk(chunk, this.responsesState);
      }
      default: {
        return parseOpenAIChunk(chunk);
      }
    }
  }
}
