// src/users/chat/gemini/response/usage-converter.ts — Gemini usage 转换

import type { InternalChatResponse } from '../../../../types';

// ==================== usage 转换 ====================

/**
 * 内部 usage → Gemini usageMetadata
 */
export function convertUsage(usage: InternalChatResponse['usage']): Record<string, unknown> | undefined {
  if (!usage) {
    return undefined;
  }

  const meta: Record<string, unknown> = {
    promptTokenCount: usage.prompt_tokens,
    candidatesTokenCount: usage.completion_tokens,
    totalTokenCount: usage.total_tokens,
  };

  if (usage.reasoning_tokens !== undefined) {
    meta['thoughtsTokenCount'] = usage.reasoning_tokens;
  }
  if (usage.cached_tokens !== undefined) {
    meta['cachedContentTokenCount'] = usage.cached_tokens;
  }

  return meta;
}
