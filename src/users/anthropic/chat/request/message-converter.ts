// src/users/claude/chat/request/message-converter.ts — Anthropic 消息格式转换

import type { ContentPart, InternalChatRequest } from '@/types';
import { mimeToMediaType } from '@/utils';
import type { AnthropicContentBlock, AnthropicMessage, AnthropicTextContentBlock } from './types';

// ==================== 系统提示词转换 ====================

/**
 * 将 Anthropic 顶层 system 字段转换为内部 role:'system' 消息
 *
 * Anthropic 的系统提示词独立于 messages 数组之外，需要手动塞回内部格式的首位。
 */
export function convertSystemPrompt(
  system?: string | AnthropicTextContentBlock[],
): InternalChatRequest['messages'][number] | undefined {
  if (system === undefined) {
    return;
  }

  if (typeof system === 'string') {
    return { role: 'system', content: system };
  }

  // AnthropicTextContentBlock[] → 拼合为纯文本
  const text = system.map((block) => block.text).join('\n');
  return { role: 'system', content: text };
}

// ==================== 内容块转换 ====================

/**
 * 将 Anthropic 内容块数组转换为内部 ContentPart[]
 *
 * 处理规则：
 * - text → TextContentPart
 * - image (base64) → MediaContentPart { base64_data, mime_type }
 * - image (url) → MediaContentPart { url }
 * - thinking → 跳过（由调用方单独提取 reasoning_content）
 * - tool_use / tool_result → 跳过（由调用方拆分为独立消息）
 */
function convertContentBlocks(blocks: AnthropicContentBlock[]): ContentPart[] {
  const parts: ContentPart[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case 'text': {
        parts.push({ type: 'text', text: block.text });
        break;
      }

      case 'image': {
        if (block.source.type === 'base64' && typeof block.source.data === 'string' && block.source.data.length > 0) {
          parts.push({
            type: mimeToMediaType(block.source.media_type ?? 'image/jpeg'),
            base64_data: block.source.data,
            mime_type: block.source.media_type ?? 'image/jpeg',
          });
        } else if (typeof block.source.url === 'string' && block.source.url.length > 0) {
          parts.push({ type: 'image', url: block.source.url });
        }
        break;
      }

      // thinking / tool_use / tool_result 在此函数中跳过，由调用方单独处理
      case 'thinking':
      case 'tool_use':
      case 'tool_result': {
        break;
      }
    }
  }

  return parts;
}

// ==================== 辅助提取 ====================

/**
 * 从 Anthropic 内容块数组中提取 thinking 文本
 *
 * 用于历史回传场景：客户端把上一轮带签名的 thinking 块发回来，
 * 我们只需要拿到纯文本即可，丢弃签名。
 */
function extractThinkingContent(blocks: AnthropicContentBlock[]): string | undefined {
  const thinkingParts = blocks.filter((b) => b.type === 'thinking');
  if (thinkingParts.length === 0) {
    return;
  }
  return thinkingParts.map((b) => (b as { thinking: string }).thinking).join('\n');
}

// ==================== 消息转换主函数 ====================

/**
 * 将 Anthropic 消息列表转换为内部统一消息格式
 *
 * Anthropic 与 OpenAI 的关键差异：
 * 1. Anthropic 没有 role='system'，系统提示词是独立的顶层字段（由 convertSystemPrompt 处理）
 * 2. Anthropic assistant 消息的 content 是内容块数组，可能包含 text + thinking + tool_use
 * 3. Anthropic 的 tool_result 是 user 消息中的内容块，需要拆分为独立的 role='tool' 消息
 */
export function convertMessages(messages: AnthropicMessage[]): InternalChatRequest['messages'] {
  const result: InternalChatRequest['messages'] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      convertUserMessage(msg, result);
    } else {
      // assistant
      convertAssistantMessage(msg, result);
    }
  }

  return result;
}

/**
 * 转换 user 消息
 *
 * Anthropic 的 user 消息可能包含 tool_result 块，需要拆成独立的 role='tool' 消息。
 * 其余普通文本/图片内容合并为一条 role='user' 消息。
 */
function convertUserMessage(msg: AnthropicMessage, result: InternalChatRequest['messages']): void {
  if (typeof msg.content === 'string') {
    result.push({ role: 'user', content: msg.content });
    return;
  }

  // 分离 tool_result 和普通内容
  const normalBlocks: AnthropicContentBlock[] = [];
  const toolResults: AnthropicContentBlock[] = [];

  for (const block of msg.content) {
    if (block.type === 'tool_result') {
      toolResults.push(block);
    } else {
      normalBlocks.push(block);
    }
  }

  // tool_result 每个独立拆为 role='tool' 消息（必须置于 user 消息之前，符合 OpenAI API 对消息编排顺序的强制要求）
  for (const block of toolResults) {
    /* istanbul ignore next -- Already filtered in previous loop */
    if (block.type !== 'tool_result') {
      continue;
    }
    const toolContent = extractToolResultContent(block.content);

    // 支持 is_error：如果遇到错误标记，将文本包装为错误标记
    let finalContent = toolContent;
    if (block.is_error && typeof toolContent === 'string') {
      finalContent = `[Error]\n${toolContent}`;
    }

    result.push({
      role: 'tool',
      content: finalContent,
      tool_call_id: block.tool_use_id,
    });
  }

  // 普通内容作为新的 user 消息，追加在 tool_result 之后（如果同一轮同时包含了 tool_result 和回复文本）
  if (normalBlocks.length > 0) {
    const contentParts = convertContentBlocks(normalBlocks);
    if (contentParts.length === 1 && contentParts[0]?.type === 'text') {
      result.push({ role: 'user', content: contentParts[0].text });
    } else if (contentParts.length > 0) {
      result.push({ role: 'user', content: contentParts });
    }
  }
}

/**
 * 转换 assistant 消息
 *
 * Anthropic assistant 消息的 content 可能同时包含 thinking + text + tool_use。
 * - thinking → reasoning_content
 * - text → 主文本内容
 * - tool_use → tool_calls 数组
 */
function convertAssistantMessage(msg: AnthropicMessage, result: InternalChatRequest['messages']): void {
  if (typeof msg.content === 'string') {
    result.push({ role: 'assistant', content: msg.content });
    return;
  }

  const blocks = msg.content;

  // 提取各部分
  const thinkingContent = extractThinkingContent(blocks);
  const textParts = blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text);
  const toolUseParts = blocks.filter((b) => b.type === 'tool_use');

  const message: InternalChatRequest['messages'][number] = {
    role: 'assistant',
    content: textParts.join('') || '',
  };

  if (thinkingContent !== undefined) {
    message.reasoning_content = thinkingContent;
  }

  // tool_use → tool_calls
  if (toolUseParts.length > 0) {
    message.tool_calls = toolUseParts.map((block) => {
      const tu = block as { id: string; name: string; input: Record<string, unknown> };
      return {
        id: tu.id,
        type: 'function' as const,
        function: {
          name: tu.name,
          arguments: JSON.stringify(tu.input),
        },
      };
    });
  }

  result.push(message);
}

// ==================== tool_result 内容提取 ====================

/**
 * 从 tool_result 的 content 字段提取纯文本
 */
function extractToolResultContent(content: string | AnthropicContentBlock[] | undefined): string | ContentPart[] {
  if (content === undefined) {
    return '';
  }
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    // 调用普通的 content blocks 解析去支撑多模态等内容
    const parts = convertContentBlocks(content);
    // 如果全是文本，降级为普通字符串，降低系统负担并兼容无法使用多模态 tool 消息格式的模型
    if (parts.length === 1 && parts[0]?.type === 'text') {
      return parts[0].text;
    }
    if (parts.every((p) => p.type === 'text')) {
      return parts.map((p) => (p as { text: string }).text).join('\n');
    }
    return parts;
  }
  return String(content);
}
