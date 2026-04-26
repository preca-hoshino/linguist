// src/types/mcp-context.ts — MCP 网关上下文类型定义
// 类比 ModelHttpContext，作为 MCP 请求全生命周期的统一上下文载体

/**
 * MCP 网关上下文对象 (MCP Gateway Context)
 *
 * 贯穿 MCP 请求全生命周期，携带归属元数据、方法调用信息、
 * 审计载荷（params/result/error）及性能计时。
 *
 * 与 ModelHttpContext 保持结构对称，但语义独立：
 * - 无 token / 计费字段（MCP 按次计费场景留待后续单独设计）
 * - 无 HTTP 适配器层概念（MCP 使用 JSON-RPC over SSE）
 */
export interface McpGatewayContext {
  /** 网关生成的请求唯一 ID（UUID v4） */
  id: string;

  // --- 归属信息 ---

  /** 关联的虚拟 MCP 配置 ID */
  virtualMcpId: string;

  /** 虚拟 MCP 用户可读名称（用于日志展示） */
  virtualMcpName: string;

  /** 实际上游 MCP Provider ID */
  mcpProviderId: string;

  /** 所属应用 ID（可选，无 App Key 鉴权时为 undefined） */
  appId?: string | undefined;

  // --- 会话 ---

  /** SSE 传输层会话 ID（由 SDK 生成） */
  sessionId: string;

  // --- 方法调用 ---

  /** MCP JSON-RPC 方法名，如 'tools/list'、'tools/call' */
  method: string;

  /**
   * 工具名称（仅 tools/call 时填充）
   * 从 params.name 中提取，冗余至窄表以支持单列索引过滤
   */
  toolName?: string | undefined;

  // --- 请求状态 ---

  /**
   * 请求状态
   * - 'completed'：调用成功完成
   * - 'error'：调用过程中发生错误
   *
   * 当前采用单次写入方案（无 processing 中间态），
   * 'processing' 值保留供未来异步 MCP 任务场景使用
   */
  status: 'processing' | 'completed' | 'error';

  // --- 审计载荷（冷数据，写入 mcp_log_details.mcp_context） ---

  /**
   * 审计数据：记录完整的请求/响应/错误载荷
   * 对应 request-logs 侧的 audit 字段，但仅有单次 JSON-RPC 交换
   */
  audit: {
    /** 请求参数（来自 JSON-RPC request.params） */
    params?: Record<string, unknown> | undefined;
    /** 成功响应内容（provider 返回的原始 result） */
    result?: Record<string, unknown> | undefined;
    /** 错误信息（调用失败时填充） */
    error?: { message: string; [key: string]: unknown } | undefined;
  };

  // --- 错误信息（冗余至窄表，便于列表过滤）---

  /** 错误信息摘要，冗余至 mcp_logs.error_message 列 */
  errorMessage?: string | undefined;

  // --- 性能计时（Unix 毫秒时间戳） ---

  /**
   * 性能计时，记录关键阶段绝对时间戳
   * 与 ModelHttpContext.timing 结构对称
   */
  timing: {
    /** 请求到达网关/处理开始时间 */
    start: number;
    /** 向上游 MCP Provider 发起转发的时间 */
    providerStart?: number | undefined;
    /** 上游 MCP Provider 响应完成时间 */
    providerEnd?: number | undefined;
    /** 完整处理流程结束时间 */
    end?: number | undefined;
  };
}
