// src/types/http/chat/shared.ts — 聊天共享基础类型（消息、工具、内容块）

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

/**
 * 深度思考配置
 *
 * 用户适配器层将各格式的思考参数统一转换为此结构：
 * - OpenAI `thinking.type` ("enabled"/"disabled"/"auto") → 直接映射 type 字段
 * - OpenAI `reasoning_effort` ("minimal"/"low"/"medium"/"high") → 在用户适配器层全量消化为 budget_tokens，不进入内部类型
 * - Gemini `thinkingBudget` / OpenAI `thinking.budget_tokens` → 直接使用
 *
 * 提供商适配器层再从此结构转换为厂商特定格式：
 * - DeepSeek：type → "enabled"/"disabled"（不支持 auto，视为 enabled）；推理强度由 budget_tokens/max_tokens 比率推断
 * - 火山引擎：type 直接透传（enabled/disabled/auto）；推理强度由 budget_tokens/max_tokens 比率推断
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

/** 停止原因统一类型 */
export type FinishReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'insufficient_system_resource'
  | 'repetition_truncation'
  | 'unknown';

/**
 * Token 使用统计（聊天）
 * 由 InternalChatResponse 和 InternalChatStreamChunk 共用。
 */
export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /**
   * 思考过程消耗的 token 数
   * 注：DeepSeek / Volcengine / Gemini 将此值与 completion_tokens 分开上报，
   * 计费层统一以相同的 output_price 合并计算，不单独定价。
   */
  reasoning_tokens?: number | undefined;
  /**
   * 上下文缓存命中的 token 数
   * DeepSeek / 火山引擎：prompt_cache_hit_tokens 映射
   * Gemini：usageMetadata.cachedContentTokenCount 映射
   */
  cached_tokens?: number | undefined;
}
