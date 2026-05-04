// src/types/ws/realtime/unions.ts — 客户端 / 服务端事件联合类型

import type { WsConversationItemCreate, WsConversationItemDelete, WsConversationItemTruncate } from './client-events';
import type {
  WsInputAudioBufferAppend,
  WsInputAudioBufferClear,
  WsInputAudioBufferCommit,
  WsResponseCancel,
  WsResponseCreate,
  WsSessionUpdate,
} from './client-events';
import type {
  WsConversationItemCreated,
  WsError,
  WsResponseAudioDelta,
  WsResponseAudioDone,
  WsResponseCreated,
  WsResponseDone,
  WsResponseTextDelta,
  WsSessionCreated,
  WsSessionUpdated,
} from './server-events';

/** 客户端可发送的所有 WebSocket 事件类型 */
export type WsClientEvent =
  | WsSessionUpdate
  | WsInputAudioBufferAppend
  | WsInputAudioBufferCommit
  | WsInputAudioBufferClear
  | WsConversationItemCreate
  | WsConversationItemTruncate
  | WsConversationItemDelete
  | WsResponseCreate
  | WsResponseCancel;

/** 服务端可推送的所有 WebSocket 事件类型 */
export type WsServerEvent =
  | WsSessionCreated
  | WsSessionUpdated
  | WsConversationItemCreated
  | WsResponseCreated
  | WsResponseTextDelta
  | WsResponseAudioDelta
  | WsResponseAudioDone
  | WsResponseDone
  | WsError;
