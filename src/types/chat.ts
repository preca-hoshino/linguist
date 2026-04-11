// src/types/chat.ts — 聊天相关类型定义

// ==================== 聊天类型 ====================

/**
 * 内部消息内容块 — 文本
 */
export interface TextContentPart {
  type: 'text';
  text: string;
}

/**
 * 内部消息内容块 — 多模态（图片/音频/视频/文件）
 */
export interface MediaContentPart {
  type: 'image' | 'audio' | 'video' | 'file';
  url?: string | undefined;
  base64_data?: string | undefined;
  /**
   * 媒体内容的 MIME 类型（如 'image/png', 'audio/mp3', 'video/mp4', 'application/pdf'）
   *
   * 来源：
   * - OpenAI 用户侧：从 data URL 前缀（`data:<mimeType>;base64,`）解析保留
   * - Gemini 用户侧：从 inlineData.mimeType / fileData.mimeType 直接映射
   * - 省略时，提供商适配器按 type 字段回退到默认值（如 image → image/jpeg）
   */
  mime_type?: string | undefined;
}

/** 内容块联合类型 */
export type ContentPart = TextContentPart | MediaContentPart;

/**
 * 工具调用定义
 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * 内部统一消息
 */
export interface InternalMessage {
  /** 消息发送者角色 */
  role: 'system' | 'user' | 'assistant' | 'tool';

  /**
   * 消息内容
   * 支持纯文本字符串，或多模态内容块数组
   */
  content: string | ContentPart[];

  /** 发送者名称 */
  name?: string | undefined;

  /**
   * [Assistant] 思维链/推理过程内容
   * 当 role='assistant' 且使用推理模型（如 DeepSeek R1）时存在
   */
  reasoning_content?: string | undefined;

  /**
   * [Assistant] 模型生成的工具调用请求
   * 当 role='assistant' 时可能存在
   */
  tool_calls?: ToolCall[] | undefined;

  /**
   * [Tool] 工具调用的回传结果 ID
   * 当 role='tool' 时必需，对应 tool_calls 中的 id
   */
  tool_call_id?: string | undefined;
}

/**
 * 工具/函数定义
 */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string | undefined;
    parameters: Record<string, unknown>;
  };
}

/** 工具选择策略 */
export type ToolChoice = 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };

/**
 * 响应格式配置
 * - text: 普通文本（默认）
 * - json_object: JSON 格式，不限制 schema
 * - json_schema: 按指定 JSON Schema 输出结构化数据
 *
 * 提供商映射：
 * - DeepSeek / 火山引擎（OpenAI 兼容）：直接透传
 * - Gemini：json_object → responseMimeType='application/json'；
 *           json_schema → responseMimeType='application/json' + responseSchema
 */
export type ResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | {
      type: 'json_schema';
      json_schema: {
        /** Schema 标识名（提供商可能用于命名生成类型） */
        name: string;
        /** 严格模式（仅允许 schema 中定义的字段） */
        strict?: boolean | undefined;
        /** JSON Schema 对象 */
        schema: Record<string, unknown>;
      };
    };

/** 停止原因统一类型 */
export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'unknown';

/**
 * 深度思考配置
 *
 * 用户适配器层将各格式的思考参数统一转换为此结构：
 * - OpenAI `thinking.type` ("enabled"/"disabled"/"auto") → 直接映射 type 字段
 * - OpenAI `reasoning_effort` ("minimal"/"low"/"medium"/"high") → minimal 映射 type:disabled，其余透传
 * - Gemini `thinkingBudget` / OpenAI `thinking.budget_tokens` → 直接使用
 *
 * 提供商适配器层再从此结构转换为厂商特定格式：
 * - DeepSeek：type → "enabled"/"disabled"（不支持 auto，视为 enabled）
 * - 火山引擎：type 直接透传（enabled/disabled/auto），reasoning_effort 作为独立顶层字段
 * - Gemini：type !== 'disabled' → includeThoughts:true，budget_tokens → thinkingBudget
 */
export interface ThinkingConfig {
  /**
   * 深度思考开关
   * - enabled：强制开启
   * - disabled：强制关闭
   * - auto：模型自行判断
   */
  type: 'enabled' | 'disabled' | 'auto';
  /**
   * 思考过程的最大 token 预算
   *
   * 由用户层根据级别描述按 max_tokens 的百分比计算，或直接数值填充，
   * 提供商层按需使用（如 Gemini thinkingBudget）。
   */
  budget_tokens?: number | undefined;
}

/**
 * Token 使用统计（聊天）
 * 由 InternalChatResponse 和 InternalChatStreamChunk 共用。
 */
export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** 思考过程消耗的 token 数（包含在 completion_tokens 中） */
  reasoning_tokens?: number | undefined;
  /**
   * 上下文缓存命中的 token 数
   * DeepSeek / 火山引擎：prompt_cache_hit_tokens 映射
   * Gemini：usageMetadata.cachedContentTokenCount 映射
   */
  cached_tokens?: number | undefined;
}

/**
 * 核心请求实体 (Chat Request)
 *
 * 注意：不包含 model 字段。模型名称由 ModelHttpContext.requestModel / routedModel 管理。
 */
export interface InternalChatRequest {
  // --- 基础参数 ---

  /** 统一消息列表，按时间顺序排列的对话历史 */
  messages: InternalMessage[];

  /**
   * 是否启用流式传输（预留接口，当前版本不实现流式）
   * true: 返回 SSE 事件流；false: 等待完整响应
   */
  stream: boolean;

  // --- 生成控制 ---

  /** 采样温度 (0.0 - 2.0) */
  temperature?: number | undefined;

  /** 核采样阈值 (0.0 - 1.0) */
  top_p?: number | undefined;

  /** Top-K 采样 */
  top_k?: number | undefined;

  /** 最大生成 token 数限制 */
  max_tokens?: number | undefined;

  /** 停止序列 */
  stop?: string | string[] | undefined;

  // --- 惩罚参数 ---

  /** 存在惩罚 (-2.0 ~ 2.0) */
  presence_penalty?: number | undefined;

  /** 频率惩罚 (-2.0 ~ 2.0) */
  frequency_penalty?: number | undefined;

  // --- 高级特性 ---

  /** 深度思考配置（DeepSeek-R1 / doubao-seed / Gemini 等支持） */
  thinking?: ThinkingConfig | undefined;

  /**
   * 推理努力级别（火山引擎 doubao-seed 系列支持）
   * - minimal：关闭思考，直接回答
   * - low：轻量思考，侧重快速响应
   * - medium：均衡模式，兼顾速度与深度（默认）
   * - high：深度分析，处理复杂问题
   *
   * 与 thinking 字段配合使用，thinking 控制开关，reasoning_effort 调节深度。
   * 仅火山引擎提供商使用此字段，其他提供商忽略。
   */
  reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high' | undefined;

  /** 可用工具/函数定义 */
  tools?: ToolDefinition[] | undefined;

  /** 工具选择策略 */
  tool_choice?: ToolChoice | undefined;

  /** 响应格式配置（JSON mode / 结构化输出） */
  response_format?: ResponseFormat | undefined;

  /** 终端用户标识（用于追踪和滥用检测） */
  user?: string | undefined;
}

// ==================== 流式响应类型 ====================

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

// ==================== 非流式响应类型 ====================

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
