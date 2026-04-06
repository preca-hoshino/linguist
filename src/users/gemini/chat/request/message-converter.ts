// src/users/gemini/chat/request/message-converter.ts — Gemini 消息转换逻辑

import type { ContentPart, InternalMessage } from '@/types';
import { createLogger, logColors, mimeToMediaType } from '@/utils';
import type {
  GeminiContent,
  GeminiFunctionCallPart,
  GeminiFunctionResponsePart,
  GeminiSystemInstruction,
} from './types';

const logger = createLogger('User:Gemini', logColors.bold + logColors.blue);

// ==================== 工具响应内容提取 ====================

/**
 * 从 functionResponse.response 中提取实际内容字符串。
 *
 * Gemini 客户端（如 MCP 客户端）通常以如下结构发送 functionResponse.response：
 *   { name: "toolName", content: "<MCP 序列化结果>" }
 * 其中 content 可能是一个 MCP 格式的 JSON 字符串：
 *   { content: [{ type: "text", text: "..." }], isError: bool }
 *
 * 本函数按优先级提取：
 * 1. 直接字符串 → 原样返回
 * 2. { content: "<JSON>" } → 解析 content，提取 text 部分
 * 3. { content: "<string>" } → 直接返回 content
 * 4. 其他对象 → JSON.stringify
 */
function extractFunctionResponseContent(response: unknown): string {
  if (typeof response === 'string') {
    return response;
  }

  if (response === null || typeof response !== 'object') {
    return String(response);
  }

  const obj = response as Record<string, unknown>;

  // MCP 风格：{ name: "...", content: "..." }，优先提取 content
  if ('content' in obj && typeof obj.content === 'string') {
    const contentStr = obj.content;
    // 尝试解析 MCP 结果格式：{ content: [{ type: "text", text: "..." }], isError: bool }
    try {
      const parsed = JSON.parse(contentStr) as unknown;
      if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as Record<string, unknown>).content)) {
        const textParts = ((parsed as Record<string, unknown>).content as unknown[])
          .filter(
            (item) =>
              typeof item === 'object' &&
              item !== null &&
              (item as Record<string, unknown>).type === 'text' &&
              typeof (item as Record<string, unknown>).text === 'string',
          )
          .map((item) => (item as Record<string, unknown>).text as string);
        if (textParts.length > 0) {
          return textParts.join('\n');
        }
      }
    } catch {
      // 非 JSON，直接使用
    }
    return contentStr;
  }

  return JSON.stringify(response);
}

// ==================== 消息转换 ====================

/**
 * 将 Gemini contents[] + systemInstruction 转为 InternalMessage[]
 */
export function convertToMessages(
  contents: GeminiContent[],
  systemInstruction?: GeminiSystemInstruction,
): InternalMessage[] {
  const messages: InternalMessage[] = [];

  // systemInstruction → 插入到 messages 开头
  if (systemInstruction) {
    const systemText = systemInstruction.parts
      .map((p) => p.text ?? '')
      .filter((t) => t.length > 0)
      .join('\n\n');

    if (systemText) {
      messages.push({
        role: 'system',
        content: systemText,
      });
    }
  }

  // contents → messages
  for (const content of contents) {
    const converted = convertContent(content);
    messages.push(...converted);
  }

  // 后处理：清除无匹配响应的 tool_calls（如 Gemini 内置工具 builtin_web_search 等）
  return removeOrphanedToolCalls(messages);
}

/**
 * 将单个 GeminiContent 转为一个或多个 InternalMessage
 *
 * 复杂情况：一个 content 可能同时包含文本 + functionCall（model 角色）
 * 或文本 + functionResponse（user 角色），需要拆分处理
 */
function convertContent(content: GeminiContent): InternalMessage[] {
  const messages: InternalMessage[] = [];
  const role = content.role === 'model' ? 'assistant' : 'user';

  // 分类 parts
  const textAndMediaParts: ContentPart[] = [];
  const functionCallParts: GeminiFunctionCallPart[] = [];
  const functionResponseParts: GeminiFunctionResponsePart[] = [];

  for (const part of content.parts) {
    if (part.functionResponse) {
      functionResponseParts.push(part);
    } else if (part.functionCall) {
      functionCallParts.push(part);
    } else if (part.fileData) {
      // fileData → 将 URI 映射为 MediaContentPart.url，保留 mimeType
      textAndMediaParts.push({
        type: mimeToMediaType(part.fileData.mimeType),
        url: part.fileData.fileUri,
        mime_type: part.fileData.mimeType,
      });
    } else if (part.inlineData) {
      // 多模态内容 → MediaContentPart，保留 mimeType
      textAndMediaParts.push({
        type: mimeToMediaType(part.inlineData.mimeType),
        base64_data: part.inlineData.data,
        mime_type: part.inlineData.mimeType,
      });
    } else if (part.text !== undefined) {
      textAndMediaParts.push({
        type: 'text',
        text: part.text,
      });
    }
  }

  // 构建 tool 响应消息列表（稍后按正确顺序插入）
  // Gemini 可能为同一个 functionCall 返回多个 functionResponse（如内置搜索工具），
  // OpenAI 格式要求每个 tool_call_id 仅有一条 tool 消息，因此同名的需要合并。
  const toolMessages: InternalMessage[] = [];
  const toolResponseByName = new Map<string, string[]>();
  // 优先使用 functionResponse.id，fallback 到函数名
  const toolResponseIdByName = new Map<string, string>();
  for (const frPart of functionResponseParts) {
    const fr = frPart.functionResponse;
    if (fr) {
      const contentStr = extractFunctionResponseContent(fr.response);
      const existing = toolResponseByName.get(fr.name);
      if (existing) {
        existing.push(contentStr);
      } else {
        toolResponseByName.set(fr.name, [contentStr]);
      }
      // 记录 id（同名只记录第一个）。工具 id 的最终规范化由 process.ts 的 normalizeToolCallIds 统一处理
      if (!toolResponseIdByName.has(fr.name)) {
        toolResponseIdByName.set(fr.name, fr.id ?? fr.name);
      }
    }
  }
  for (const [name, contents] of toolResponseByName) {
    toolMessages.push({
      role: 'tool',
      content: contents.join('\n\n'),
      name,
      tool_call_id: toolResponseIdByName.get(name) ?? name,
    });
  }

  // 构建 tool_calls 列表（仅 model/assistant 角色）
  const toolCalls =
    functionCallParts.length > 0 && role === 'assistant'
      ? functionCallParts
          .filter(
            (
              fc,
            ): fc is GeminiFunctionCallPart & {
              functionCall: NonNullable<GeminiFunctionCallPart['functionCall']>;
            } => !!fc.functionCall,
          )
          .map((fc) => ({
            // 优先使用 Gemini 2.x+ 提供的 id，回退到函数名。
            // 最终 id 规范化由 process.ts 的 normalizeToolCallIds 统一处理
            id: fc.functionCall.id ?? fc.functionCall.name,
            type: 'function' as const,
            function: {
              name: fc.functionCall.name,
              arguments: JSON.stringify(fc.functionCall.args),
            },
          }))
      : [];

  const hasToolCalls = toolCalls.length > 0;
  const hasToolResponses = toolMessages.length > 0;
  const hasContent = textAndMediaParts.length > 0;

  if (hasToolCalls && hasToolResponses) {
    // 同一 content 中同时有 functionCall 和 functionResponse
    // （Gemini 内置工具的典型模式：调用和响应在同一轮）
    // OpenAI 格式要求：assistant(tool_calls) → tool → assistant(text)

    // 1) assistant 消息携带 tool_calls（不含文本，文本是工具调用后的最终回复）
    messages.push(
      {
        role: 'assistant',
        content: '',
        tool_calls: toolCalls,
      },
      ...toolMessages,
    );

    // 3) 如果有文本内容，作为单独的 assistant 消息（工具调用后的最终回复）
    if (hasContent) {
      messages.push({
        role: 'assistant',
        content: simplifyContent(textAndMediaParts),
      });
    }
  } else if (hasToolResponses) {
    // 仅有 functionResponse（无 functionCall），如 user 角色提供工具结果
    // tool 消息在前，文本消息在后
    messages.push(...toolMessages);
    if (hasContent) {
      messages.push({
        role: role as InternalMessage['role'],
        content: simplifyContent(textAndMediaParts),
      });
    }
  } else if (hasContent || hasToolCalls) {
    // 普通消息（可能带 tool_calls），合并为单条消息
    const msg: InternalMessage = {
      role: role as InternalMessage['role'],
      content: simplifyContent(textAndMediaParts),
    };
    if (hasToolCalls) {
      msg.tool_calls = toolCalls;
    }
    messages.push(msg);
  }

  return messages;
}

/**
 * 简化 ContentPart[]：
 * - 如果只有一个文本 part，返回纯字符串
 * - 否则返回完整 ContentPart[]
 */
function simplifyContent(parts: ContentPart[]): string | ContentPart[] {
  if (parts.length === 0) {
    return '';
  }
  const first = parts[0];
  if (parts.length === 1 && first?.type === 'text') {
    return first.text;
  }
  return parts;
}

// ==================== 孤立 tool_calls 清理 ====================

/**
 * 移除没有对应 tool 响应消息的 tool_calls，以及没有对应 tool_call 的 tool 消息。
 *
 * Gemini 内置工具（如 builtin_web_search）由 Gemini 内部处理，
 * 对话历史中可能只包含 functionCall 而没有显式 functionResponse，
 * 转换为 OpenAI 格式后会导致下游提供商（如 DeepSeek）报错。
 */
function removeOrphanedToolCalls(messages: InternalMessage[]): InternalMessage[] {
  // 收集所有 tool 消息的 tool_call_id
  const respondedIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.tool_call_id !== undefined && msg.tool_call_id !== '') {
      respondedIds.add(msg.tool_call_id);
    }
  }

  // 收集所有 assistant 消息中的 tool_call id
  const calledIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        calledIds.add(tc.id);
      }
    }
  }

  const result: InternalMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      // 过滤掉没有对应 tool 响应的 tool_calls
      const filtered = msg.tool_calls.filter((tc) => respondedIds.has(tc.id));
      if (filtered.length === 0) {
        // 全部 tool_calls 都是孤立的，移除 tool_calls 字段
        const { tool_calls: _removed, ...rest } = msg;
        // 仅在消息仍有内容时保留
        if (rest.content !== '') {
          result.push(rest as InternalMessage);
        }
      } else {
        result.push({ ...msg, tool_calls: filtered });
      }
    } else if (msg.role === 'tool') {
      // 过滤掉没有对应 assistant tool_call 的 tool 消息
      if (msg.tool_call_id !== undefined && msg.tool_call_id !== '' && calledIds.has(msg.tool_call_id)) {
        result.push(msg);
      } else {
        logger.debug(
          { toolCallId: msg.tool_call_id, name: msg.name },
          'Removing orphaned tool response message (no matching tool_call)',
        );
      }
    } else {
      result.push(msg);
    }
  }

  return result;
}
