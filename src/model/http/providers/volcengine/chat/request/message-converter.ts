// src/providers/chat/volcengine/request/message-converter.ts — 火山引擎消息转换（含多模态）

import type { ContentPart, InternalMessage, MediaContentPart } from '@/types';
import { createLogger, logColors } from '@/utils';
import type { VolcEngineContentPart, VolcEngineMessage } from './types';

const logger = createLogger('Provider:VolcEngine', logColors.bold + logColors.magenta);

// ==================== MIME 类型推断 ====================

/** 根据内部媒体类型推断默认 MIME 子类型 */
const MEDIA_DEFAULT_SUBTYPE: Record<string, string> = {
  image: 'jpeg',
  audio: 'wav',
  video: 'mp4',
  file: 'octet-stream',
};

// ==================== 多模态转换 ====================

/**
 * 将内部 MediaContentPart 转为火山引擎 image_url 格式
 *
 * 火山引擎支持两种图片引用方式：
 * - 远程 URL：{ type: 'image_url', image_url: { url: 'https://...' } }
 * - Base64 编码：{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,...' } }
 *
 * 仅支持 image 类型。其他媒体类型（audio/video/file）仅作 warn 日志跳过。
 */
function convertMediaPart(part: MediaContentPart): VolcEngineContentPart | null {
  if (part.type !== 'image') {
    logger.warn({ type: part.type }, 'VolcEngine only supports image multimodal; skipping unsupported media type');
    return null;
  }

  // 优先使用 URL（远程引用更高效）
  if (part.url !== undefined && part.url.length > 0) {
    return {
      type: 'image_url',
      image_url: { url: part.url },
    };
  }

  // 回退到 base64 inline data
  if (part.base64_data !== undefined && part.base64_data.length > 0) {
    // 优先使用 mime_type，回退到根据类型推断
    const mimeType = part.mime_type ?? `image/${MEDIA_DEFAULT_SUBTYPE[part.type] ?? 'jpeg'}`;
    const dataUrl = `data:${mimeType};base64,${part.base64_data}`;
    return {
      type: 'image_url',
      image_url: { url: dataUrl },
    };
  }

  logger.warn({ type: part.type }, 'Skipping media part without url or base64_data');
  return null;
}

/**
 * 将 string | ContentPart[] 转为火山引擎 content 格式
 * - 纯文本：保持 string
 * - 多模态（含 image）：转为 VolcEngineContentPart[]
 * - 仅文本 parts：简化为 string
 */
function convertContent(content: string | ContentPart[]): string | VolcEngineContentPart[] {
  if (typeof content === 'string') {
    return content;
  }

  const parts: VolcEngineContentPart[] = [];
  let hasMedia = false;

  for (const part of content) {
    if (part.type === 'text') {
      parts.push({ type: 'text', text: part.text });
    } else {
      const converted = convertMediaPart(part);
      if (converted) {
        parts.push(converted);
        hasMedia = true;
      }
    }
  }

  // 如果没有媒体内容，简化为纯文本字符串
  if (!hasMedia) {
    return parts
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('\n');
  }

  return parts;
}

// ==================== 消息转换 ====================

/**
 * 将内部消息列表转为火山引擎消息格式
 *
 * 转换规则：
 * - content: 内部 ContentPart[] → 火山引擎 string | VolcEngineContentPart[]
 * - assistant 消息：保留 reasoning_content、tool_calls
 * - tool 消息：保留 tool_call_id
 */
export function convertMessages(messages: InternalMessage[]): VolcEngineMessage[] {
  return messages.map((msg) => {
    const converted: VolcEngineMessage = {
      role: msg.role,
      content: convertContent(msg.content),
    };

    // assistant 消息可能携带 reasoning_content 和 tool_calls
    if (msg.role === 'assistant') {
      if (typeof msg.reasoning_content === 'string') {
        converted.reasoning_content = msg.reasoning_content;
      }
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        converted.tool_calls = msg.tool_calls;
      }
    }

    // tool 消息需要 tool_call_id
    if (msg.role === 'tool' && msg.tool_call_id !== undefined) {
      converted.tool_call_id = msg.tool_call_id;
    }

    // 透传 name 字段
    if (msg.name !== undefined) {
      converted.name = msg.name;
    }

    return converted;
  });
}
