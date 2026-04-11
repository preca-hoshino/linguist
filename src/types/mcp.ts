// src/types/mcp.ts — MCP 协议映射类型（占位）

// TODO: Phase 4 按 MCP 协议规范完善

/** MCP 工具定义（对应 MCP ToolDefinition） */
export interface McpToolDefinition {
  /** 工具名称（全局唯一，推荐 namespace/toolName 格式） */
  name: string;

  /** 工具描述（供 LLM 理解工具用途） */
  description?: string | undefined;

  /** 工具输入参数的 JSON Schema */
  inputSchema: Record<string, unknown>;
}

/** MCP 工具调用请求 */
export interface McpCallRequest {
  /** 目标工具名称 */
  toolName: string;

  /** 工具调用参数 */
  arguments: Record<string, unknown>;
}

/** MCP 内容块（文本 / 图片 / 资源） */
export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; text?: string | undefined } };

/** MCP 工具调用响应 */
export interface McpCallResponse {
  /** 响应内容块列表 */
  content: McpContent[];

  /** 是否为错误响应 */
  isError?: boolean | undefined;
}
