// src/types/chat-request.ts — 聊天请求类型

import type {
  InternalMessage,
  ResponseFormat,
  ThinkingConfig,
  ToolChoice,
  ToolDefinition,
} from './chat-shared';

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

  /** 可用工具/函数定义 */
  tools?: ToolDefinition[] | undefined;

  /** 工具选择策略 */
  tool_choice?: ToolChoice | undefined;

  /** 响应格式配置（JSON mode / 结构化输出） */
  response_format?: ResponseFormat | undefined;

  /** 终端用户标识（用于追踪和滥用检测） */
  user?: string | undefined;
}
