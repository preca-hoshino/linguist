// src/types/ws/realtime/conversation.ts — 对话项类型

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
