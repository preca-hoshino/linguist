// src/users/claude/chat/request/types.ts — Anthropic Messages API 请求相关类型定义

// ==================== Anthropic 内容块类型 ====================

/** Anthropic 文本内容块 */
export interface AnthropicTextContentBlock {
  type: 'text';
  text: string;
}

/** Anthropic 图片内容块 */
export interface AnthropicImageContentBlock {
  type: 'image';
  source: {
    type: 'base64' | 'url';
    media_type?: string;
    data?: string;
    url?: string;
  };
}

/** Anthropic 思考内容块（Extended Thinking 历史回传） */
export interface AnthropicThinkingContentBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

/** Anthropic 工具调用内容块 */
export interface AnthropicToolUseContentBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Anthropic 工具结果内容块 */
export interface AnthropicToolResultContentBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | AnthropicContentBlock[];
  is_error?: boolean;
}

/** Anthropic 内容块联合类型 */
export type AnthropicContentBlock =
  | AnthropicTextContentBlock
  | AnthropicImageContentBlock
  | AnthropicThinkingContentBlock
  | AnthropicToolUseContentBlock
  | AnthropicToolResultContentBlock;

// ==================== Anthropic 消息类型 ====================

/** Anthropic 消息（对话历史中的单条） */
export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

// ==================== Anthropic 请求体类型 ====================

/** Anthropic Messages API 请求体 */
export interface AnthropicRequestBody {
  /** 模型名称（由 API 路由层提取，适配器不处理） */
  model?: string;

  /** 对话消息列表（不含系统提示词） */
  messages: AnthropicMessage[];

  /** 系统提示词（顶层独立字段） */
  system?: string | AnthropicTextContentBlock[];

  /** 最大输出 token 数 */
  max_tokens: number;

  /** 是否启用流式 */
  stream?: boolean;

  /** 采样温度 */
  temperature?: number;

  /** Top-P 核采样 */
  top_p?: number;

  /** Top-K 采样 */
  top_k?: number;

  /** 停止序列 */
  stop_sequences?: string[];

  /** Extended Thinking 配置 */
  thinking?: {
    /**
     * 思考类型
     * - enabled: 强制开启
     * - disabled: 强制关闭
     * - adaptive: Claude Code 新版本引入，模型自适应决定是否思考，语义等同 enabled
     */
    type: 'enabled' | 'disabled' | 'adaptive';
    budget_tokens?: number;
  };

  /** 工具定义列表 */
  tools?: AnthropicTool[];

  /** 工具选择策略 */
  tool_choice?: AnthropicToolChoice;

  /** 元数据（安全丢弃，不传给下游） */
  metadata?: Record<string, unknown>;
}

// ==================== Anthropic 工具类型 ====================

/** Anthropic 工具定义 */
export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

/** Anthropic 工具选择策略 */
export type AnthropicToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'none' }
  | { type: 'tool'; name: string };

// ==================== 内部复用类型别名 ====================
