// src/types/realtime.ts — WebSocket 实时事件帧类型（V2 网关占位）

// TODO: Phase 3 按 OpenAI Realtime 协议规范完善
// 参考: https://platform.openai.com/docs/api-reference/realtime

/**
 * 内部统一 WebSocket 事件帧
 *
 * 对应 OpenAI Realtime 协议的事件类型，如:
 * - session.update / session.created
 * - conversation.item.create
 * - response.create / response.done
 * - input_audio_buffer.append / commit
 */
export interface InternalWSFrame {
  /** 事件类型标识 (如 'session.update', 'response.create') */
  type: string;

  /** 事件 ID（由客户端或服务端生成，用于关联请求-响应） */
  event_id?: string | undefined;

  /** 扩展字段（各事件类型的具体载荷，Phase 3 按需细化） */
  [key: string]: unknown;
}
