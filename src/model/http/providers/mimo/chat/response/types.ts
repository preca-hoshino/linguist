// src/providers/mimo/chat/response/types.ts — MiMo 响应相关类型定义

import type { ToolCall } from '@/types';

/** MiMo API usage 结构 */
export interface MiMoUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
  prompt_tokens_details?: {
    cached_tokens?: number;
    audio_tokens?: number;
    image_tokens?: number;
    video_tokens?: number;
  };
  /** 联网搜索用量（MiMo 特有） */
  web_search_usage?: {
    tool_usage?: number;
    page_usage?: number;
  };
}

/** MiMo API choice 结构（非流式） */
export interface MiMoChoice {
  index: number;
  message: {
    role: string;
    content: string | null;
    reasoning_content?: string;
    tool_calls?: ToolCall[];
    /** 联网搜索引用注释（MiMo 特有，当前丢弃） */
    annotations?: unknown[];
    /** 内容审核错误信息 */
    error_message?: string;
    /** 音频响应（TTS 模型，当前丢弃） */
    audio?: unknown;
  };
  finish_reason: string;
}

/** MiMo API 完整响应结构 */
export interface MiMoResponse {
  id?: string;
  choices: MiMoChoice[];
  model?: string;
  created?: number;
  usage?: MiMoUsage;
}
