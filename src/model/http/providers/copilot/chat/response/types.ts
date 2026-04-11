// src/providers/copilot/chat/response/types.ts — Copilot 响应类型定义

import type { ToolCall } from '@/types';

/** Copilot API usage 结构（标准 OpenAI 格式，无 Copilot 特有扩展字段） */
export interface CopilotUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** Copilot API choice 结构（标准 OpenAI 格式，无 reasoning_content） */
export interface CopilotChoice {
  index: number;
  message: {
    content: string | null;
    tool_calls?: ToolCall[];
  };
  finish_reason: string;
}

/** Copilot API 完整响应结构 */
export interface CopilotResponse {
  choices: CopilotChoice[];
  usage?: CopilotUsage;
}
