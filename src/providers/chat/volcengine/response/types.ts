// src/providers/chat/volcengine/response/types.ts — 火山引擎响应相关类型定义

import type { ToolCall } from '../../../../types';

/** 火山引擎 API usage 结构 */
export interface VolcEngineUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
}

/** 火山引擎 API choice 结构 */
export interface VolcEngineChoice {
  index: number;
  message: {
    role: 'assistant';
    content: string | null;
    reasoning_content?: string;
    tool_calls?: ToolCall[];
  };
  finish_reason: string;
}

/** 火山引擎 API 完整响应结构 */
export interface VolcEngineResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: VolcEngineChoice[];
  usage?: VolcEngineUsage;
}
