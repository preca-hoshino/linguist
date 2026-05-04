// src/types/chat-response.ts — 非流式响应类型

import type { ChatUsage, FinishReason, ToolCall } from './chat-shared';

/**
 * 非流式候选项（对应 InternalChatResponse.choices[] 的单项）
 */
export interface ChatChoice {
  /** choices 数组位置索引 */
  index: number;
  /** 模型生成的消息 */
  message: {
    role: 'assistant';
    /**
     * 最终呈现给用户的回复文本
     * 当 finish_reason='tool_calls' 且无文本内容时为 null（OpenAI 规范）
     */
    content: string | null;
    /** 思维链内容（推理模型返回） */
    reasoning_content?: string | undefined;
    /** 模型发起的工具调用请求 */
    tool_calls?: ToolCall[] | undefined;
  };
  /** 停止原因 */
  finish_reason: FinishReason;
}

/**
 * 聊天响应实体（非流式）
 *
 * 不含 id / model / created，由 ModelHttpContext 统一管理。
 */
export interface InternalChatResponse {
  /** 候选项列表（通常只有 index=0 一项） */
  choices: ChatChoice[];
  /** Token 消耗统计 */
  usage?: ChatUsage | undefined;
}
