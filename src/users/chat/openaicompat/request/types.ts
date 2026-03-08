// src/users/chat/openaicompat/request/types.ts — OpenAI 兼容请求相关类型定义

import type { InternalChatRequest } from '../../../../types';

// ==================== OpenAI 兼容多模态内容类型 ====================

/** OpenAI 兼容文本内容块 */
export interface OpenAICompatTextContentPart {
  type: 'text';
  text: string;
}

/** OpenAI 兼容图片内容块 */
export interface OpenAICompatImageContentPart {
  type: 'image_url';
  image_url: {
    url: string;
    detail?: 'auto' | 'low' | 'high';
  };
}

/** OpenAI 兼容格式内容块联合类型 */
export type OpenAICompatContentPart = OpenAICompatTextContentPart | OpenAICompatImageContentPart;

// ==================== OpenAI 兼容用户请求类型定义 ====================

/** OpenAI 兼容格式的消息类型（可能包含客户端透传的额外字段） */
export interface OpenAICompatChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | OpenAICompatContentPart[] | null;
  name?: string;
  reasoning_content?: string | null;
  tool_calls?:
    | {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }[]
    | null;
  tool_call_id?: string;
}

/** OpenAI 兼容 reasoning_effort 级别描述 */
export type OpenAICompatReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

/** OpenAI 兼容格式的聊天请求体类型 */
export interface OpenAICompatChatRequestBody {
  messages: OpenAICompatChatMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  max_tokens?: number;
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  /**
   * 推理努力级别（火山引擎 doubao-seed 系列 / OpenAI o1/o3 系列参数）
   * - minimal：关闭思考，映射为 thinking.type = 'disabled'
   * - low / medium / high：透传至内部，支持 Gemini budget_tokens 计算及 VolcEngine 直接透传
   */
  reasoning_effort?: OpenAICompatReasoningEffort;
  /**
   * 思考配置（优先级高于 reasoning_effort）
   * - type: 'enabled' 强制开启，'disabled' 强制关闭，'auto' 模型自判
   * - budget_tokens: Gemini 思考预算（可选）
   */
  thinking?: InternalChatRequest['thinking'];
  tools?: InternalChatRequest['tools'];
  tool_choice?: InternalChatRequest['tool_choice'];
  /** 响应格式配置（JSON mode / 结构化输出） */
  response_format?: InternalChatRequest['response_format'];
  /** 终端用户标识（用于追踪和滥用检测） */
  user?: string;
}
