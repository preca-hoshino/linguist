// src/model/http/providers/newapi/chat/response/types.ts — New API 响应相关类型定义
//
// New API 使用 OpenAI 兼容的响应格式

import type { ToolCall } from '@/types';

/** New API usage 结构 */
export interface NewApiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
  prompt_cache_hit_tokens?: number;
}

/** New API choice 结构 */
export interface NewApiChoice {
  index: number;
  message: {
    content: string | null;
    reasoning_content?: string;
    tool_calls?: ToolCall[];
  };
  finish_reason: string;
}

/** New API 完整响应结构 */
export interface NewApiResponse {
  choices: NewApiChoice[];
  usage?: NewApiUsage;
}
