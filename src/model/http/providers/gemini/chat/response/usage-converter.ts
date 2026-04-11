// src/providers/chat/gemini/response/usage-converter.ts — Gemini usage 转换

import type { InternalChatResponse } from '@/types';
import type { GeminiUsageMetadata } from './types';

// ==================== usage 转换 ====================

/**
 * Gemini usageMetadata → 内部 usage 格式
 */
export function convertUsage(meta?: GeminiUsageMetadata): InternalChatResponse['usage'] {
  if (!meta) {
    return;
  }

  const promptTokens = meta.promptTokenCount ?? 0;
  const completionTokens = meta.candidatesTokenCount ?? 0;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: meta.totalTokenCount ?? promptTokens + completionTokens,
    reasoning_tokens: meta.thoughtsTokenCount,
    cached_tokens: meta.cachedContentTokenCount,
  };
}
