// src/types/ws/realtime/frame.ts — 内部统一 WebSocket 事件帧

/**
 * 内部统一 WebSocket 事件帧 (InternalWSFrame)
 *
 * WsClientEvent | WsServerEvent 的超集，附加内部路由和控制字段。
 * 网关管线内部统一使用此类型，由协议适配器完成序列化/反序列化。
 */
export interface InternalWSFrame {
  /** 事件类型标识 (如 'session.update', 'response.create') */
  type: string;

  /** 事件 ID（由客户端或服务端生成，用于关联请求-响应） */
  event_id?: string | undefined;

  /** 会话 ID（管线内部分发路由用） */
  session_id?: string | undefined;

  /** 扩展字段（各事件类型的具体载荷） */
  [key: string]: unknown;
}
