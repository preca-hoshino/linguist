// src/users/openaicompat/chat/request/message-converter.ts — OpenAI 兼容消息清洗转换

import type { ContentPart, InternalChatRequest } from '@/types';
import { mimeToMediaType } from '@/utils';
import type { OpenAICompatChatMessage, OpenAICompatContentPart } from './types';

// ==================== Data URL 解析 ====================

/** data URL 正则：匹配 data:image/jpeg;base64,xxx */
const DATA_URL_PATTERN = /^data:([^;]+);base64,(.+)$/;

// ==================== 内容转换 ====================

/**
 * 将 OpenAI 格式的 content 转换为内部 ContentPart[]
 * - text → TextContentPart
 * - image_url（远程 URL）→ MediaContentPart { type: 'image', url }
 * - image_url（data URL）→ MediaContentPart { type: 推断, base64_data }
 */
function convertContentParts(parts: OpenAICompatContentPart[]): ContentPart[] {
  return parts.map((part) => {
    if (part.type === 'text') {
      return { type: 'text', text: part.text };
    }

    // image_url → MediaContentPart
    const { url } = part.image_url;
    const dataMatch = DATA_URL_PATTERN.exec(url);

    if (dataMatch) {
      // data:image/jpeg;base64,xxx → base64_data，保留原始 MIME 类型
      /* istanbul ignore next -- fallback safety, regex + guarantees match */
      const mimeType = dataMatch[1] ?? 'image/jpeg';
      /* istanbul ignore next -- fallback safety, regex + guarantees match */
      const base64Data = dataMatch[2] ?? '';
      return {
        type: mimeToMediaType(mimeType),
        base64_data: base64Data,
        mime_type: mimeType,
      };
    }

    // 远程 URL：无法从 URL 推断 MIME 类型，留空由提供商回退默认值
    return { type: 'image' as const, url };
  });
}

/**
 * 将 OpenAI 消息的 content 字段转为内部格式
 */
function convertContent(content: string | OpenAICompatContentPart[] | null | undefined): string | ContentPart[] {
  if (content === null || content === undefined) {
    return '';
  }
  if (typeof content === 'string') {
    return content;
  }
  return convertContentParts(content);
}

// ==================== 消息转换 ====================

/**
 * 清洗 OpenAI 消息列表：
 * - 将 OpenAI image_url 格式转为内部 MediaContentPart
 * - 移除 undefined/null 的可选字段，保留有效值
 */
export function convertMessages(messages: OpenAICompatChatMessage[]): InternalChatRequest['messages'] {
  return messages.map((msg) => {
    const cleaned: InternalChatRequest['messages'][number] = {
      role: msg.role,
      content: convertContent(msg.content),
    };
    if (msg.name !== undefined) {
      cleaned.name = msg.name;
    }
    if (typeof msg.reasoning_content === 'string') {
      cleaned.reasoning_content = msg.reasoning_content;
    }
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      cleaned.tool_calls = msg.tool_calls;
    }
    if (msg.tool_call_id !== undefined) {
      cleaned.tool_call_id = msg.tool_call_id;
    }
    return cleaned;
  });
}
