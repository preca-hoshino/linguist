// src/types/realtime.ts — WebSocket 实时事件帧类型
//
// 参考: https://platform.openai.com/docs/api-reference/realtime

// ==================== 客户端 → 服务端事件 ====================

/**
 * session.update — 客户端请求更新会话配置
 */
export interface WsSessionUpdate {
  type: 'session.update';
  event_id?: string | undefined;
  session: {
    /** 会话级指令（系统提示） */
    instructions?: string | undefined;
    /** 语音选择（如 'alloy', 'echo', 'shimmer'） */
    voice?: string | undefined;
    /** 输入音频格式 */
    input_audio_format?: 'pcm16' | 'g711_ulaw' | 'g711_alaw' | undefined;
    /** 输出音频格式 */
    output_audio_format?: 'pcm16' | 'g711_ulaw' | 'g711_alaw' | undefined;
    /** 输入音频转写配置 */
    input_audio_transcription?:
      | {
          enabled: boolean;
          model?: string | undefined;
        }
      | undefined;
    /** 对话轮次检测配置 */
    turn_detection?:
      | {
          type: 'server_vad';
          threshold?: number | undefined;
          prefix_padding_ms?: number | undefined;
          silence_duration_ms?: number | undefined;
        }
      | undefined;
    /** 温度参数 */
    temperature?: number | undefined;
    /** 最大输出 Token */
    max_response_output_tokens?: number   | undefined;
    /** 其他扩展配置 */
    [key: string]: unknown;
  };
}

/**
 * input_audio_buffer.append — 客户端追加音频数据
 */
export interface WsInputAudioBufferAppend {
  type: 'input_audio_buffer.append';
  event_id?: string | undefined;
  /** Base64 编码的音频数据 */
  audio: string;
}

/**
 * input_audio_buffer.commit — 客户端提交音频缓冲区
 */
export interface WsInputAudioBufferCommit {
  type: 'input_audio_buffer.commit';
  event_id?: string | undefined;
}

/**
 * input_audio_buffer.clear — 客户端清空音频缓冲区
 */
export interface WsInputAudioBufferClear {
  type: 'input_audio_buffer.clear';
  event_id?: string | undefined;
}

/**
 * conversation.item.create — 客户端创建对话项
 */
export interface WsConversationItemCreate {
  type: 'conversation.item.create';
  event_id?: string | undefined;
  previous_item_id?: string | undefined;
  item: WsConversationItem;
}

/**
 * conversation.item.truncate — 客户端截断对话项
 */
export interface WsConversationItemTruncate {
  type: 'conversation.item.truncate';
  event_id?: string | undefined;
  item_id: string;
  content_index: number;
  audio_end_ms: number;
}

/**
 * conversation.item.delete — 客户端删除对话项
 */
export interface WsConversationItemDelete {
  type: 'conversation.item.delete';
  event_id?: string | undefined;
  item_id: string;
}

/**
 * response.create — 客户端请求生成响应
 */
export interface WsResponseCreate {
  type: 'response.create';
  event_id?: string | undefined;
  response?:
    | {
        instructions?: string | undefined;
        voice?: string | undefined;
        output_audio_format?: string | undefined;
        temperature?: number | undefined;
        max_response_output_tokens?: number | undefined;
        tools?: unknown[] | undefined;
        [key: string]: unknown;
      }
    | undefined;
}

/**
 * response.cancel — 客户端取消正在进行的响应
 */
export interface WsResponseCancel {
  type: 'response.cancel';
  event_id?: string | undefined;
}

// ==================== 服务端 → 客户端事件 ====================

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

// ==================== 对话项类型 ====================

/**
 * 对话项内容块
 */
export type WsContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_audio'; audio: string; transcript?: string | undefined }
  | { type: 'text'; text: string }
  | { type: 'audio'; audio: string; transcript?: string | undefined };

/**
 * 对话项
 */
export interface WsConversationItem {
  id?: string | undefined;
  object?: 'realtime.item' | undefined;
  type?: 'message' | 'function_call' | 'function_call_output' | undefined;
  role?: 'user' | 'assistant' | 'system' | undefined;
  content?: WsContentPart[] | undefined;
  [key: string]: unknown;
}

// ==================== 客户端 → 服务端事件联合 ====================

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

// ==================== 服务端 → 客户端事件联合 ====================

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

// ==================== 内部统一帧 ====================

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
