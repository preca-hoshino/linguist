// src/users/gemini/chat/response/candidate-converter.ts — Gemini candidate 转换

import type { InternalChatResponse } from '@/types';
import { safeParseJson } from '@/utils';

// ==================== Gemini 响应类型 ====================

/**
 * finishReason 映射：内部 → Gemini
 */
const FINISH_REASON_MAP: Record<string, string> = {
  stop: 'STOP',
  length: 'MAX_TOKENS',
  tool_calls: 'STOP', // Gemini 不区分 tool_calls，以 STOP + functionCall parts 表达
  content_filter: 'SAFETY',
  unknown: 'STOP',
};

// ==================== candidate 转换 ====================

/** 将内部 choice 转为 Gemini candidate 格式（含 thought/text/functionCall parts 和 finishReason 映射） */
export function convertCandidate(choice: InternalChatResponse['choices'][number]): Record<string, unknown> {
  const parts: Record<string, unknown>[] = [];

  // 1) 思维链内容 → thought part（放在前面）
  if (typeof choice.message.reasoning_content === 'string' && choice.message.reasoning_content.length > 0) {
    parts.push({
      text: choice.message.reasoning_content,
      thought: true,
    });
  }

  // 2) 文本内容 → text part
  if (choice.message.content !== null && choice.message.content.length > 0) {
    parts.push({ text: choice.message.content });
  }

  // 3) tool_calls → functionCall parts（携带 id 以支持 Gemini 2.x+ 精确关联）
  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      const fcPart: Record<string, unknown> = {
        name: tc.function.name,
        args: safeParseJson(tc.function.arguments),
      };
      if (tc.id && tc.id.length > 0) {
        fcPart.id = tc.id;
      }
      parts.push({ functionCall: fcPart });
    }
  }

  return {
    content: {
      role: 'model',
      parts,
    },
    finishReason: FINISH_REASON_MAP[choice.finish_reason] ?? 'STOP',
  };
}
