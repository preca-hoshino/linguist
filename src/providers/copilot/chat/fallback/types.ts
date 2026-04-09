// src/providers/copilot/chat/fallback/types.ts — Copilot 端点协议类型定义

// ==================== 端点类型枚举 ====================

/** Copilot 支持的 API 端点类型 */
export type CopilotEndpointType = 'chat-completions' | 'messages' | 'responses';

// ==================== Anthropic Messages 协议类型 ====================

/** Anthropic 文本内容块 */
export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

/** Anthropic 工具使用内容块 */
export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Anthropic 工具结果内容块 */
export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | AnthropicTextBlock[];
}

/** Anthropic 图像内容块 */
export interface AnthropicImageBlock {
  type: 'image';
  source:
    | {
        type: 'base64';
        media_type: string;
        data: string;
      }
    | {
        type: 'url';
        url: string;
      };
}

/** Anthropic 消息内容块联合类型 */
export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicImageBlock;

/** Anthropic 消息类型 */
export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

/** Anthropic 工具定义 */
export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

/** Anthropic tool_choice 类型 */
export type AnthropicToolChoice = { type: 'auto' } | { type: 'any' } | { type: 'tool'; name: string };

/** Anthropic Messages API 请求负载 */
export interface AnthropicMessagesPayload {
  model: string;
  messages: AnthropicMessage[];
  system?: string;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  stream?: boolean;
}

/** Anthropic 完整响应中的内容块 */
export type AnthropicResponseContent = AnthropicTextBlock | AnthropicToolUseBlock;

/** Anthropic Usage 信息 */
export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Anthropic 非流式完整响应 */
export interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AnthropicResponseContent[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

// ==================== Anthropic 流式 SSE 事件类型 ====================

/** message_start 事件 */
export interface AnthropicMessageStartEvent {
  type: 'message_start';
  message: Omit<AnthropicResponse, 'content'> & { content: [] };
}

/** content_block_start 事件 */
export interface AnthropicContentBlockStartEvent {
  type: 'content_block_start';
  index: number;
  content_block: AnthropicTextBlock | (Omit<AnthropicToolUseBlock, 'input'> & { input: '' });
}

/** content_block_delta 文本 delta */
export interface AnthropicTextDelta {
  type: 'text_delta';
  text: string;
}

/** content_block_delta 工具输入 delta */
export interface AnthropicInputJsonDelta {
  type: 'input_json_delta';
  partial_json: string;
}

/** content_block_delta 事件 */
export interface AnthropicContentBlockDeltaEvent {
  type: 'content_block_delta';
  index: number;
  delta: AnthropicTextDelta | AnthropicInputJsonDelta;
}

/** content_block_stop 事件 */
export interface AnthropicContentBlockStopEvent {
  type: 'content_block_stop';
  index: number;
}

/** message_delta 事件 */
export interface AnthropicMessageDeltaEvent {
  type: 'message_delta';
  delta: {
    stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | null;
    stop_sequence: string | null;
  };
  usage: {
    output_tokens: number;
  };
}

/** message_stop 事件 */
export interface AnthropicMessageStopEvent {
  type: 'message_stop';
}

/** ping 事件 */
export interface AnthropicPingEvent {
  type: 'ping';
}

/** Anthropic SSE 事件联合类型 */
export type AnthropicStreamEvent =
  | AnthropicMessageStartEvent
  | AnthropicContentBlockStartEvent
  | AnthropicContentBlockDeltaEvent
  | AnthropicContentBlockStopEvent
  | AnthropicMessageDeltaEvent
  | AnthropicMessageStopEvent
  | AnthropicPingEvent;

/**
 * Anthropic 流式翻译状态机
 * 用于跨 SSE 事件追踪工具调用内容块的累积状态
 */
export interface AnthropicStreamState {
  /** 当前正在构建的内容块索引 → 工具调用 ID 映射 */
  toolCallIndexToId: Map<number, string>;
  /** 当前正在构建的工具调用 → 参数 JSON 字符串 */
  toolCallIndexToName: Map<number, string>;
  /** 标记是否已发出 role: assistant */
  roleEmitted: boolean;
  /** 最终 stop_reason（来自 message_delta） */
  stopReason: string | null;
  /** 来自 message_start 的初始 usage */
  inputTokens: number;
}

// ==================== OpenAI Responses API 协议类型 ====================

/** Responses API 输入消息 */
export interface ResponsesInputMessage {
  role: 'user' | 'assistant' | 'system' | 'developer';
  content: string | Array<{ type: 'input_text'; text: string } | { type: 'input_image'; image_url: string }>;
}

/** Responses API 工具定义 */
export interface ResponsesFunctionTool {
  type: 'function';
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean;
}

/** Responses API tool_choice */
export type ResponsesToolChoice = 'auto' | 'required' | 'none' | { type: 'function'; name: string };

/** Responses API 请求负载 */
export interface ResponsesPayload {
  model: string;
  input: ResponsesInputMessage[];
  instructions?: string;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  tools?: ResponsesFunctionTool[];
  tool_choice?: ResponsesToolChoice;
  stream?: boolean;
}

/** Responses API 完整响应中的输出文本块 */
export interface ResponsesOutputText {
  type: 'output_text';
  text: string;
  annotations?: unknown[];
}

/** Responses API 函数调用块 */
export interface ResponsesFunctionCall {
  type: 'function_call';
  id: string;
  call_id: string;
  name: string;
  arguments: string;
}

/** Responses API 输出块联合类型 */
export type ResponsesOutputContent = ResponsesOutputText | ResponsesFunctionCall;

/** Responses API 输出消息 */
export interface ResponsesOutputMessage {
  type: 'message';
  id: string;
  role: 'assistant';
  content: ResponsesOutputContent[];
  status: 'completed' | 'in_progress' | 'incomplete';
}

/** Responses API 非流式完整响应 */
export interface ResponsesResult {
  id: string;
  object: 'response';
  model: string;
  output: ResponsesOutputMessage[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  status: 'completed' | 'failed' | 'cancelled' | 'incomplete';
  error?: {
    code: string;
    message: string;
  };
}

// ==================== Responses 流式 SSE 事件类型 ====================

/** response.created 事件 */
export interface ResponsesCreatedEvent {
  type: 'response.created';
  response: Omit<ResponsesResult, 'output'> & { output: [] };
}

/** response.output_item.added 事件 */
export interface ResponsesOutputItemAddedEvent {
  type: 'response.output_item.added';
  output_index: number;
  item: Omit<ResponsesOutputMessage, 'content'> & { content: [] };
}

/** response.content_part.added 事件 */
export interface ResponsesContentPartAddedEvent {
  type: 'response.content_part.added';
  item_id: string;
  output_index: number;
  content_index: number;
  part: { type: 'output_text'; text: ''; annotations: [] } | { type: 'function_call' };
}

/** response.output_text.delta 事件 */
export interface ResponsesOutputTextDeltaEvent {
  type: 'response.output_text.delta';
  item_id: string;
  output_index: number;
  content_index: number;
  delta: string;
}

/** response.function_call_arguments.delta 事件 */
export interface ResponsesFunctionCallDeltaEvent {
  type: 'response.function_call_arguments.delta';
  item_id: string;
  output_index: number;
  call_id: string;
  delta: string;
}

/** response.function_call_arguments.done 事件 */
export interface ResponsesFunctionCallDoneEvent {
  type: 'response.function_call_arguments.done';
  item_id: string;
  output_index: number;
  call_id: string;
  arguments: string;
}

/** response.output_item.done 事件 */
export interface ResponsesOutputItemDoneEvent {
  type: 'response.output_item.done';
  output_index: number;
  item: ResponsesOutputMessage;
}

/** response.completed 事件 */
export interface ResponsesCompletedEvent {
  type: 'response.completed';
  response: ResponsesResult;
}

/** rate_limits.updated 事件 */
export interface ResponsesRateLimitsEvent {
  type: 'rate_limits.updated';
}

/** Responses API SSE 事件联合类型 */
export type ResponseStreamEvent =
  | ResponsesCreatedEvent
  | ResponsesOutputItemAddedEvent
  | ResponsesContentPartAddedEvent
  | ResponsesOutputTextDeltaEvent
  | ResponsesFunctionCallDeltaEvent
  | ResponsesFunctionCallDoneEvent
  | ResponsesOutputItemDoneEvent
  | ResponsesCompletedEvent
  | ResponsesRateLimitsEvent;

/**
 * Responses 流式翻译状态机
 * 用于跨 SSE 事件追踪函数调用块的累积状态
 */
export interface ResponsesStreamState {
  /** 函数调用块的 output_index → call_id 映射 */
  functionCallIndexToCallId: Map<number, string>;
  /** 函数调用块的 output_index → name 映射 */
  functionCallIndexToName: Map<number, string>;
  /** 是否已发出 response.created（防止重复处理） */
  started: boolean;
}
