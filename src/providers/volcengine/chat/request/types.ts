// src/providers/chat/volcengine/request/types.ts — 火山引擎请求相关类型定义

// ==================== 火山引擎消息内容类型 ====================

/** 火山引擎文本内容块 */
export interface VolcEngineTextContentPart {
  type: 'text';
  text: string;
}

/** 火山引擎图片内容块 */
export interface VolcEngineImageContentPart {
  type: 'image_url';
  image_url: {
    url: string;
  };
}

/** 火山引擎内容块联合类型 */
export type VolcEngineContentPart = VolcEngineTextContentPart | VolcEngineImageContentPart;

// ==================== 火山引擎消息类型 ====================

/** 火山引擎消息（发送给 API 的格式） */
export interface VolcEngineMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | VolcEngineContentPart[];
  name?: string;
  reasoning_content?: string;
  tool_calls?: {
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }[];
  tool_call_id?: string;
}

// ==================== 火山引擎 Thinking 配置 ====================
