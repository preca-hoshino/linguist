// src/users/claude/chat/response/usage-converter.ts — Anthropic usage 转换

import type { ChatUsage } from '@/types';

// ==================== usage 转换 ====================

/**
 * 内部 ChatUsage → Anthropic usage 格式
 *
 * Anthropic 格式:
 * {
 *   input_tokens: number,
 *   output_tokens: number,
 *   cache_read_input_tokens?: number
 * }
 */
export function convertUsage(usage?: ChatUsage): Record<string, unknown> {
  if (!usage) {
    return { input_tokens: 0, output_tokens: 0 };
  }

  const result: Record<string, unknown> = {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
  };

  if (usage.cached_tokens !== undefined) {
    result.cache_read_input_tokens = usage.cached_tokens;
  }

  return result;
}
