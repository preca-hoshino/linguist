// src/providers/chat/gemini/response/candidate-converter.ts — Gemini candidate 转换

import type { FinishReason, InternalChatResponse, ToolCall } from '@/types';
import type { GeminiCandidate } from './types';

// ==================== finishReason 映射 ====================

/**
 * Gemini finishReason → 内部统一 finish_reason
 *
 * Gemini 值:
 *   STOP       → stop
 *   MAX_TOKENS → length
 *   SAFETY     → content_filter
 *   RECITATION → content_filter
 *   其他       → unknown
 */
const FINISH_REASON_MAP: Record<string, FinishReason> = {
  STOP: 'stop',
  MAX_TOKENS: 'length',
  SAFETY: 'content_filter',
  RECITATION: 'content_filter',
};

// ==================== candidate 转换 ====================

/**
 * 将 Gemini candidate 转为内部 choice 格式
 * - 分离文本、思维链、函数调用
 * - 映射 finishReason
 */
export function convertCandidate(
  candidate: GeminiCandidate,
  fallbackIndex: number,
): InternalChatResponse['choices'][number] {
  const parts = candidate.content?.parts ?? [];

  // 分离文本、思维链、函数调用
  const textParts: string[] = [];
  const thoughtParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  let toolCallCounter = 0;

  for (const part of parts) {
    // 思维链内容（Gemini thinking 特性）
    if (part.thought && part.text !== undefined) {
      thoughtParts.push(part.text);
      continue;
    }

    // 函数调用
    if (part.functionCall) {
      toolCalls.push({
        id: `call_${fallbackIndex}_${toolCallCounter++}`,
        type: 'function',
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args),
        },
      });
      continue;
    }

    // 普通文本
    if (part.text !== undefined) {
      textParts.push(part.text);
    }
  }

  // 当只有 tool_calls 无文本时，content 应为 null（符合 OpenAI 规范）
  let content: string | null;
  if (textParts.length > 0) {
    content = textParts.join('');
  } else if (toolCalls.length > 0) {
    content = null;
  } else {
    content = '';
  }
  const reasoningContent = thoughtParts.length > 0 ? thoughtParts.join('') : undefined;
  const finishReason = mapFinishReason(candidate.finishReason, toolCalls.length > 0);

  return {
    index: fallbackIndex,
    message: {
      role: 'assistant',
      content,
      reasoning_content: reasoningContent,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    },
    finish_reason: finishReason,
  };
}

// ==================== finishReason 映射 ====================

function mapFinishReason(reason: string | undefined, hasToolCalls: boolean): FinishReason {
  // 如果包含函数调用，优先标记为 tool_calls
  if (hasToolCalls) {
    return 'tool_calls';
  }

  if (reason === undefined || reason === '') {
    return 'unknown';
  }

  return FINISH_REASON_MAP[reason] ?? 'unknown';
}
