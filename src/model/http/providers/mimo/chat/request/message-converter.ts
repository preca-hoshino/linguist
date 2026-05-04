// src/providers/mimo/chat/request/message-converter.ts — MiMo 消息处理

import type { ContentPart, InternalMessage } from '@/types';
import { createLogger, logColors } from '@/utils';

const logger = createLogger('Provider:MiMo', logColors.bold + logColors.blue);

// ==================== 内容格式转换 ====================

/**
 * 将单个内部 ContentPart 转换为 MiMo / OpenAI API 格式
 *
 * MiMo 使用 OpenAI 兼容的多模态格式：
 * - TextContentPart → { type: 'text', text }
 * - MediaContentPart (image) → { type: 'image_url', image_url: { url } }
 * - MediaContentPart (audio/video/file) → 跳过并记录警告
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
  // 所有其余类型（audio/video/file）MiMo Chat 模型均不支持
  logger.warn({ type: part.type }, 'MiMo chat models do not support this media type; skipping');
  return null;
}

/**
 * 将内部消息的 content 字段转换为 MiMo API 格式
 */
function convertContent(content: string | ContentPart[]): string | Record<string, unknown>[] {
  if (typeof content === 'string') {
    return content;
  }
  return content.map((part) => convertContentPart(part)).filter((p): p is Record<string, unknown> => p !== null);
}

// ==================== 消息列表转换 ====================

/**
 * 将内部消息列表规范化为 MiMo / OpenAI 兼容格式
 *
 * 特殊处理：
 * - developer 角色 → 映射为 system（MiMo 支持 developer 角色，但 InternalMessage 无此枚举值，
 *   用户侧 developer 消息进入时已由上游适配器转为 system，此处仅做兜底）
 * - assistant 消息携带 reasoning_content → 原样传递（满足多轮思考对话需求）
 * - assistant 消息携带 tool_calls → 原样传递
 * - content ContentPart[] → OpenAI image_url 格式
 * - 保留 tool_call_id / name 有效字段
 */
export function normalizeMessages(messages: InternalMessage[]): Record<string, unknown>[] {
  return messages.map((msg) => {
    const normalized: Record<string, unknown> = {
      role: msg.role,
      content: convertContent(msg.content),
    };

    // 发送者名称
    if (msg.name !== undefined && msg.name.length > 0) {
      normalized.name = msg.name;
    }

    // Assistant 消息：携带思考内容
    if (msg.role === 'assistant') {
      if (msg.reasoning_content !== undefined) {
        normalized.reasoning_content = msg.reasoning_content;
      }
      // 工具调用
      if (msg.tool_calls !== undefined && msg.tool_calls.length > 0) {
        normalized.tool_calls = msg.tool_calls;
      }
    }

    // Tool 消息：工具调用回传 ID
    if (msg.role === 'tool' && msg.tool_call_id !== undefined) {
      normalized.tool_call_id = msg.tool_call_id;
    }

    return normalized;
  });
}
