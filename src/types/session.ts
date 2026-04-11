// src/types/session.ts — WebSocket 会话上下文类型（V2 网关占位）

// TODO: Phase 3 按 SessionContext 完整规格完善

/**
 * WebSocket 会话上下文
 * 贯穿 WebSocket 长连接生命周期的唯一载体，类似 HTTP 层的 GatewayContext。
 * 与 GatewayContext 不同，SessionContext 是有状态的，关联整个连接而非单次请求。
 */
export interface SessionContext {
  /** 会话唯一 ID */
  id: string;

  /** 客户端 IP */
  ip: string;

  /** 原始 API Key */
  apiKey?: string | undefined;

  /** 所属应用 ID */
  appId?: string | undefined;

  /** 用户请求的虚拟模型 ID */
  model: string;

  /** 用户协议格式（当前仅 'realtime'） */
  userFormat: string;

  /** 连接时间轴 */
  timing: {
    /** 连接建立时间戳 (Unix ms) */
    connected: number;
  };

  /** 会话状态机状态 */
  state: 'connecting' | 'ready' | 'streaming' | 'closed';
}
