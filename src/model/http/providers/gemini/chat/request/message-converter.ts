// src/providers/chat/gemini/request/message-converter.ts — Gemini 消息转换

import type { ContentPart, InternalMessage } from '@/types';
import { createLogger, logColors, safeParseJson } from '@/utils';
import type {
  GeminiContent,
  GeminiFileDataPart,
  GeminiInlineDataPart,
  GeminiPart,
  GeminiSystemInstruction,
} from './types';

const logger = createLogger('Provider:Gemini', logColors.bold + logColors.yellow);

// ==================== MIME 类型映射 ====================

/** 各媒体类型对应的默认 MIME 类型（用于 inlineData） */
const MEDIA_TYPE_DEFAULT_MIME: Record<string, string> = {
  image: 'image/jpeg',
  audio: 'audio/mp4',
  video: 'video/mp4',
  file: 'application/octet-stream',
};

// ==================== 公开接口 ====================

/**
 * 将 InternalMessage[] 拆分为 systemInstruction + contents[]
 * - role=system 的消息合并到 systemInstruction（仅文本）
 * - role=user/assistant/tool 映射到 contents
 *
 * Gemini 不支持 'system' 或 'assistant' 角色，需要做映射：
 * - assistant → model
 * - tool → user（携带 functionResponse part）
 */
export function convertMessages(messages: InternalMessage[]): {
  systemInstruction: GeminiSystemInstruction | null;
  contents: GeminiContent[];
} {
  const systemTexts: string[] = [];
  const contents: GeminiContent[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = extractTextContent(msg.content);
      if (text) {
        systemTexts.push(text);
      }
      continue;
    }

    if (msg.role === 'tool') {
      contents.push(convertToolMessage(msg));
      continue;
    }

    if (msg.role === 'assistant') {
      contents.push(convertAssistantMessage(msg));
      continue;
    }

    // user 消息
    contents.push(convertUserMessage(msg));
  }

  const systemInstruction: GeminiSystemInstruction | null =
    systemTexts.length > 0 ? { role: 'user', parts: [{ text: systemTexts.join('\n\n') }] } : null;

  return { systemInstruction, contents };
}

// ==================== 消息转换 ====================

/** 将 user 消息转为 Gemini Content */
function convertUserMessage(msg: InternalMessage): GeminiContent {
  return {
    role: 'user',
    parts: convertContentToParts(msg.content),
  };
}

/**
 * 将 assistant 消息转为 Gemini Content (role=model)
 * 如含 tool_calls，附加 functionCall parts
 */
function convertAssistantMessage(msg: InternalMessage): GeminiContent {
  const parts: GeminiPart[] = [];

  // 文本 / 多模态内容
  const contentParts = convertContentToParts(msg.content);
  parts.push(...contentParts);

  // tool_calls → functionCall parts
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      parts.push({
        functionCall: {
          name: tc.function.name,
          args: safeParseJson(tc.function.arguments),
        },
      });
    }
  }

  return { role: 'model', parts };
}

/**
 * 将 tool 消息转为 Gemini Content (role=user + functionResponse)
 * Gemini 将函数调用结果放在 user 角色下
 */
function convertToolMessage(msg: InternalMessage): GeminiContent {
  const responseContent = extractTextContent(msg.content);
  return {
    role: 'user',
    parts: [
      {
        functionResponse: {
          name: msg.name ?? msg.tool_call_id ?? 'unknown',
          response: safeParseJson(responseContent),
        },
      },
    ],
  };
}

// ==================== 内容块转换 ====================

/**
 * 将 string | ContentPart[] 转为 GeminiPart[]
 */
function convertContentToParts(content: string | ContentPart[]): GeminiPart[] {
  if (typeof content === 'string') {
    return content ? [{ text: content }] : [];
  }

  const parts: GeminiPart[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      parts.push({ text: part.text });
    } else {
      // 多模态内容 → inlineData
      const geminiPart = convertMediaPart(part);
      if (geminiPart) {
        parts.push(geminiPart);
      }
    }
  }
  return parts;
}

/**
 * 将 MediaContentPart 转为 Gemini inlineData 或 fileData part
 * - 优先使用 base64_data → inlineData
 * - 若仅有 url → fileData（适用于 Google Cloud Storage URI 或其他可访问 URI）
 * - mime_type 字段优先于默认値，避免误将原始类型
 */
function convertMediaPart(part: ContentPart): GeminiInlineDataPart | GeminiFileDataPart | null {
  if (part.type === 'text') {
    return null;
  }

  // 优先使用 mime_type，回退到默认分类
  const mimeType = part.mime_type ?? MEDIA_TYPE_DEFAULT_MIME[part.type] ?? 'application/octet-stream';

  // 优先使用内联 base64 数据
  if (part.base64_data !== undefined) {
    return {
      inlineData: {
        mimeType,
        data: part.base64_data,
      },
    };
  }

  // 其次使用 URL 引用（fileData）
  if (part.url !== undefined) {
    return {
      fileData: {
        mimeType,
        fileUri: part.url,
      },
    };
  }

  logger.warn({ type: part.type }, 'Skipping media part without base64_data or url');
  return null;
}

// ==================== 辅助方法 ====================

/** 从 string | ContentPart[] 中提取纯文本 */
function extractTextContent(content: string | ContentPart[]): string {
  if (typeof content === 'string') {
    return content;
  }
  return content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}
