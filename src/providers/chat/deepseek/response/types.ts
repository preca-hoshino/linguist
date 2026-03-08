// src/providers/chat/deepseek/response/types.ts — DeepSeek 响应相关类型定义

import type { ToolCall } from '../../../../types';

/** DeepSeek API usage 结构 */
export interface DeepSeekUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
  prompt_cache_hit_tokens?: number;
}

/** DeepSeek API choice 结构 */
export interface DeepSeekChoice {
  index: number;
  message: {
    content: string | null;
    reasoning_content?: string;
    tool_calls?: ToolCall[];
  };
  finish_reason: string;
}

/** DeepSeek API 完整响应结构 */
export interface DeepSeekResponse {
  choices: DeepSeekChoice[];
  usage?: DeepSeekUsage;
}
