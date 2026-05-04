// src/types/ws/realtime/client-events.ts — 客户端 → 服务端事件
//
// 参考: https://platform.openai.com/docs/api-reference/realtime

import type { WsConversationItem } from './conversation';

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
    max_response_output_tokens?: number | undefined;
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
