// src/types/session.ts — WebSocket 会话上下文类型

import type { InternalWSFrame } from './realtime';

/**
 * WebSocket 会话上下文 (ModelWsContext)
 *
 * 贯穿 WebSocket 长连接生命周期的唯一载体，类似 HTTP 层的 ModelHttpContext。
 * 与 ModelHttpContext 的本质区别：
 * - 有状态 — 关联整个连接而非单次请求/响应
 * - 事件驱动 — 通过 InternalWSFrame 双向通信
 * - 长生命周期 — 可跨越多轮对话交互
 */
export interface ModelWsContext {
  // --- 基础元数据 ---

  /** 会话唯一 ID（UUID v4） */
  id: string;

  /** 客户端 IP 地址 */
  ip: string;

  /** 关联的 WebSocket 实例标识（用于多实例路由） */
  socketId?: string | undefined;

  // --- 认证 ---

  /** 原始传入的 API Key（日志中需脱敏） */
  apiKey?: string | undefined;

  /** API Key 分配的名称 */
  apiKeyName?: string | undefined;

  /** 所属应用 ID */
  appId?: string | undefined;

  /** 所属应用名称 */
  appName?: string | undefined;

  // --- 路由 ---

  /** 用户请求的虚拟模型 ID */
  model: string;

  /** 用户协议格式（当前仅 'realtime'） */
  userFormat: string;

  /** 路由解析后的提供商信息 */
  route?:
    | {
        /** 提供商标识（如 'openai'、'deepseek'） */
        providerKind: string;
        /** 实际调用的提供商模型名 */
        routedModel: string;
        /** 提供商配置快照 */
        providerConfig?: Record<string, unknown> | undefined;
      }
    | undefined;

  // --- 时间轴 ---

  timing: {
    /** 连接建立时间戳 (Unix ms) */
    connected: number;
    /** 最后一次活动时间戳 (Unix ms) */
    lastActive?: number | undefined;
    /** 连接断开时间戳 (Unix ms) */
    disconnected?: number | undefined;
  };

  // --- 会话状态机 ---

  /** 会话状态 */
  state: WsSessionState;

  // --- 事件缓冲区 ---

  /** 待发送事件队列（按序推送） */
  pendingEvents: InternalWSFrame[];

  /** 已接收事件序列号（用于去重） */
  lastReceivedEventId?: string | undefined;

  // --- 计费 ---

  /** 会话级累计计费信息 */
  billing?:
    | {
        /** 累计输入 Token */
        inputTokens: number;
        /** 累计输出 Token */
        outputTokens: number;
        /** 累计音频时长（毫秒） */
        audioDurationMs: number;
      }
    | undefined;
}

/** WebSocket 会话状态机状态 */
export type WsSessionState = 'connecting' | 'ready' | 'streaming' | 'closed';

/** WebSocket 会话事件枚举 */
export type WsSessionEvent =
  | 'session.created'
  | 'session.updated'
  | 'conversation.item.created'
  | 'conversation.item.deleted'
  | 'conversation.item.truncated'
  | 'response.created'
  | 'response.done'
  | 'response.text.delta'
  | 'response.audio.delta'
  | 'input_audio_buffer.append'
  | 'input_audio_buffer.commit'
  | 'input_audio_buffer.cleared'
  | 'error'
  | 'close';
