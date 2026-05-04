// src/types/http/chat/streaming.ts — 流式响应类型

import type { ChatUsage, FinishReason } from './shared';

/**
 * 工具调用增量（流式）
 *
 * 与非流式 ToolCall 对应，流式场景下各字段均为可选，
 * 适配器负责将多个 delta 按 index 合并成完整的 ToolCall。
 */
export interface ToolCallDelta {
  /** 对应 tool_calls 数组的索引（多并发工具调用对齐用） */
  index: number;
  /** 工具调用 ID（通常仅第一个 chunk 包含） */
  id?: string | undefined;
  /** 工具类型（通常仅第一个 chunk 包含） */
  type?: 'function' | undefined;
  function?:
    | {
        /** 函数名（通常仅第一个 chunk 包含） */
        name?: string | undefined;
        /** 函数参数 JSON 字符串的增量片段 */
        arguments?: string | undefined;
      }
    | undefined;
}

/**
 * 流式内容增量（对应 choices[].delta）
 *
 * - 首个 chunk：通常包含 role，content 为空字符串
 * - 中间 chunk：content / reasoning_content / tool_calls 等字段携带增量
 * - 末尾 chunk（finish_reason 非 null）：delta 通常为空对象
 */
export interface ChatStreamDelta {
  /** 消息角色（仅第一个 chunk 携带，固定为 'assistant'） */
  role?: 'assistant' | undefined;
  /** 回复文本的增量片段 */
  content?: string | undefined;
  /**
   * 思维链/推理过程的增量片段
   * DeepSeek-R1 / doubao-seed 思考模式时出现；
   * Gemini thinkingConfig.includeThoughts=true 时由适配器从 thought part 提取。
   */
  reasoning_content?: string | undefined;
  /**
   * 工具调用的增量片段
   * 流式场景下一次完整调用会拆分到多个 chunk，调用方通过 index 合并。
   */
  tool_calls?: ToolCallDelta[] | undefined;
}

/**
 * 流式候选项（对应 InternalChatStreamChunk.choices[] 的单项）
 */
export interface ChatStreamChoice {
  /** choices 数组位置索引 */
  index: number;
  /** 内容增量 */
  delta: ChatStreamDelta;
  /**
   * 停止原因
   * null 表示生成未结束；非 null 出现在该候选项的最后一个 chunk。
   */
  finish_reason: FinishReason | null;
}

/**
 * 单个流式事件 chunk（对应 SSE 的一行 `data: {...}`）
 *
 * 不含 id / model / created，由 ModelHttpContext 统一管理。
 * SSE 流以 `data: [DONE]` 结束，调用方检测到该标记后停止读取。
 */
export interface InternalChatStreamChunk {
  /** 候选项增量列表（通常只有 index=0 一项） */
  choices: ChatStreamChoice[];

  /**
   * Token 使用统计（通常只在整个流的最后一个有效 chunk 中出现）
   * - DeepSeek / 火山引擎：需请求时携带 `stream_options.include_usage: true`
   * - Gemini：在最后一个 chunk 的 `usageMetadata` 字段中返回
   */
  usage?: ChatUsage | undefined;
}
