// src/providers/chat/deepseek/request/message-converter.ts — DeepSeek 消息处理

import type { ContentPart, InternalMessage } from '@/types';
import { createLogger, logColors } from '@/utils';

const logger = createLogger('Provider:DeepSeek', logColors.bold + logColors.green);

// ==================== 内容格式转换 ====================

/**
 * 将单个内部 ContentPart 转换为 DeepSeek/OpenAI API 格式
 *
 * DeepSeek 使用 OpenAI 兼容的多模态格式：
 * - TextContentPart → { type: 'text', text }
 * - MediaContentPart (image) → { type: 'image_url', image_url: { url } }
 * - 其他媒体类型（audio/video/file）DeepSeek 不支持，跳过并记录警告
 */
function convertContentPart(part: ContentPart): Record<string, unknown> | null {
  if (part.type === 'text') {
    return { type: 'text', text: part.text };
  }
  if (part.type === 'image') {
    if (part.url !== undefined && part.url.length > 0) {
      return { type: 'image_url', image_url: { url: part.url } };
    }
    if (part.base64_data !== undefined && part.base64_data.length > 0) {
      const mimeType = part.mime_type ?? 'image/jpeg';
      return { type: 'image_url', image_url: { url: `data:${mimeType};base64,${part.base64_data}` } };
    }
    logger.warn({ type: part.type }, 'Skipping image part without url or base64_data');
    return null;
  }
  // audio/video/file：DeepSeek 当前不支持
  logger.warn({ type: part.type }, 'DeepSeek does not support this media type; skipping');
  return null;
}

/**
 * 将内部消息的 content 字段转换为 DeepSeek API 格式
 *
 * - string → 保持原样
 * - ContentPart[] → OpenAI 兼容的 content parts 数组（已过滤不支持的类型）
 */
function convertContent(content: string | ContentPart[]): string | Record<string, unknown>[] {
  if (typeof content === 'string') {
    return content;
  }
  return content.map((part) => convertContentPart(part)).filter((p): p is Record<string, unknown> => p !== null);
}

// ==================== 消息列表转换 ====================

/**
 * 将内部消息列表规范化为 DeepSeek/OpenAI 兼容格式（非 reasoner 模型）
 *
 * 主要处理：
 * - content ContentPart[] → OpenAI image_url 格式
 * - 保留 tool_calls / tool_call_id / name 有效字段
 * - 移除 reasoning_content（非 reasoner 模型无需透传）
 */
export function normalizeMessages(messages: InternalMessage[]): Record<string, unknown>[] {
  return messages.map((msg) => {
    const normalized: Record<string, unknown> = {
      role: msg.role,
      content: convertContent(msg.content),
    };
    if (msg.name !== undefined) {
      normalized.name = msg.name;
    }
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      normalized.tool_calls = msg.tool_calls;
    }
    if (msg.tool_call_id !== undefined) {
      normalized.tool_call_id = msg.tool_call_id;
    }
    return normalized;
  });
}

/**
 * 为 DeepSeek reasoner 模型处理消息列表：
 * - 所有 assistant 消息必须包含 reasoning_content 字段（至少为空字符串）
 * - 清除非 assistant 消息上多余的 reasoning_content
 * - content ContentPart[] 同样转换为 OpenAI image_url 格式
 */
export function prepareMessagesForReasoner(messages: InternalMessage[]): Record<string, unknown>[] {
  return messages.map((msg) => {
    if (msg.role === 'assistant') {
      const result: Record<string, unknown> = {
        role: msg.role,
        content: convertContent(msg.content),
        reasoning_content: msg.reasoning_content ?? '',
      };
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        result.tool_calls = msg.tool_calls;
      }
      return result;
    }
    // 非 assistant 消息，转换内容格式并移除不必要的字段
    const cleaned: Record<string, unknown> = {
      role: msg.role,
      content: convertContent(msg.content),
    };
    if (msg.name !== undefined) {
      cleaned.name = msg.name;
    }
    if (msg.tool_call_id !== undefined) {
      cleaned.tool_call_id = msg.tool_call_id;
    }
    return cleaned;
  });
}
