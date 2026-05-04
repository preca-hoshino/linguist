// src/types/ws/realtime/server-events.ts — 服务端 → 客户端事件

import type { WsConversationItem } from './conversation';

/**
 * session.created — 服务端确认会话已创建
 */
export interface WsSessionCreated {
  type: 'session.created';
  event_id: string;
  session: {
    id: string;
    object: 'realtime.session';
    model: string;
    /** 服务端默认会话配置 */
    [key: string]: unknown;
  };
}

/**
 * session.updated — 服务端确认会话已更新
 */
export interface WsSessionUpdated {
  type: 'session.updated';
  event_id: string;
  session: Record<string, unknown>;
}

/**
 * conversation.item.created — 服务端通知对话项已创建
 */
export interface WsConversationItemCreated {
  type: 'conversation.item.created';
  event_id: string;
  previous_item_id?: string | undefined;
  item: WsConversationItem;
}

/**
 * response.created — 服务端通知响应已开始
 */
export interface WsResponseCreated {
  type: 'response.created';
  event_id: string;
  response: {
    id: string;
    object: 'realtime.response';
    status: 'in_progress' | 'completed' | 'cancelled' | 'failed';
    output: WsConversationItem[];
    [key: string]: unknown;
  };
}

/**
 * response.text.delta — 服务端推送文本增量
 */
export interface WsResponseTextDelta {
  type: 'response.text.delta';
  event_id: string;
  response_id: string;
  item_id: string;
  output_index: number;
  content_index: number;
  delta: string;
}

/**
 * response.audio.delta — 服务端推送音频增量
 */
export interface WsResponseAudioDelta {
  type: 'response.audio.delta';
  event_id: string;
  response_id: string;
  item_id: string;
  output_index: number;
  content_index: number;
  /** Base64 编码的音频增量数据 */
  delta: string;
}

/**
 * response.audio.done — 服务端通知音频推送结束
 */
export interface WsResponseAudioDone {
  type: 'response.audio.done';
  event_id: string;
  response_id: string;
  item_id: string;
  output_index: number;
  content_index: number;
}

/**
 * response.done — 服务端通知响应已完成
 */
export interface WsResponseDone {
  type: 'response.done';
  event_id: string;
  response: {
    id: string;
    object: 'realtime.response';
    status: 'completed' | 'cancelled' | 'failed';
    output: WsConversationItem[];
    usage?:
      | {
          total_tokens: number;
          input_tokens: number;
          output_tokens: number;
          input_token_details?:
            | {
                text_tokens: number;
                audio_tokens: number;
              }
            | undefined;
          output_token_details?:
            | {
                text_tokens: number;
                audio_tokens: number;
              }
            | undefined;
        }
      | undefined;
    [key: string]: unknown;
  };
}

/**
 * error — 服务端推送错误事件
 */
export interface WsError {
  type: 'error';
  event_id: string;
  error: {
    type: string;
    code?: string | undefined;
    message: string;
    param?: string | undefined;
  };
}
