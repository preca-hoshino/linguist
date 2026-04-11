// src/users/openaicompat/chat/response/usage-converter.ts — OpenAI 兼容 usage 转换

import type { InternalChatResponse } from '@/types';

// ==================== usage 转换 ====================

/**
 * 内部 usage → OpenAI usage 格式（含 cached_tokens / reasoning_tokens 详情）
 */
export function convertUsage(usage?: InternalChatResponse['usage']): Record<string, unknown> | undefined {
  if (!usage) {
    return;
  }

  return {
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    ...(usage.cached_tokens !== undefined && {
      prompt_tokens_details: {
        cached_tokens: usage.cached_tokens,
      },
    }),
    ...(usage.reasoning_tokens !== undefined && {
      completion_tokens_details: {
        reasoning_tokens: usage.reasoning_tokens,
      },
    }),
  };
}
