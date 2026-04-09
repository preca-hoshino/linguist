// src/providers/copilot/chat/request/index.ts — Copilot 请求适配器

import type { ProviderChatRequestAdapter } from '@/providers/types';
import type { ContentPart, InternalChatRequest, InternalMessage, ToolDefinition } from '@/types';
import { createLogger, logColors } from '@/utils';

const logger = createLogger('Provider:Copilot', logColors.bold + logColors.cyan);

// ==================== 消息内容格式转换 ====================

/**
 * 将单个 ContentPart 转换为 OpenAI 兼容 API 格式
 * - TextContentPart → { type: 'text', text }
 * - MediaContentPart (image) → { type: 'image_url', image_url: { url } }
 * - audio/video/file：Copilot 不支持，跳过并记录警告
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
  logger.warn({ type: part.type }, 'Copilot does not support this media type; skipping');
  return null;
}

/**
 * 将内部消息 content 字段转换为 OpenAI 兼容格式
 * - string → 保持原样
 * - ContentPart[] → 过滤后的 content parts 数组
 */
function convertContent(content: string | ContentPart[]): string | Record<string, unknown>[] {
  if (typeof content === 'string') {
    return content;
  }
  return content.map((part) => convertContentPart(part)).filter((p): p is Record<string, unknown> => p !== null);
}

/**
 * 将内部消息列表规范化为 OpenAI 兼容格式
 * 保留 tool_calls / tool_call_id / name 等字段，移除 reasoning_content（Copilot 不支持）
 */
function normalizeMessages(messages: InternalMessage[]): Record<string, unknown>[] {
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

// ==================== 工具参数规范化 ====================

/**
 * 规范化工具 parameters，确保符合 OpenAI 兼容 API 要求（type: "object"）
 * 处理 MCP 工具等无参数场景下 parameters 为 null 或 {type: null} 的情况
 */
function normalizeToolParameters(parameters: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!parameters || typeof parameters !== 'object') {
    return { type: 'object', properties: {} };
  }
  if (parameters.type === null || parameters.type === 'null') {
    return {
      type: 'object',
      properties: {},
      ...Object.fromEntries(Object.entries(parameters).filter(([k]) => k !== 'type')),
    };
  }
  if (parameters.type !== 'object') {
    return { ...parameters, type: 'object', ...(parameters.properties === undefined ? { properties: {} } : {}) };
  }
  return parameters;
}

/**
 * 对 tools 数组中每个工具的 parameters 做规范化处理
 */
function normalizeTools(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.map((t) => ({
    ...t,
    function: { ...t.function, parameters: normalizeToolParameters(t.function.parameters) },
  }));
}

/**
 * Copilot 聊天请求适配器
 * InternalChatRequest + routedModel → Copilot API 请求体（OpenAI 兼容格式）
 *
 * 与 DeepSeek 适配器的主要差异：
 * - 无 reasoner 模型检测逻辑
 * - 无 reasoning_content 处理
 * - response_format 支持全部 OpenAI 格式（包括 json_schema）
 */
export class CopilotChatRequestAdapter implements ProviderChatRequestAdapter {
  public toProviderRequest(internalReq: InternalChatRequest, routedModel: string): Record<string, unknown> {
    logger.debug(
      {
        routedModel,
        messagesCount: internalReq.messages.length,
        hasTools: !!internalReq.tools,
      },
      'Adapting internal request to Copilot format',
    );

    const messages = normalizeMessages(internalReq.messages);

    const req: Record<string, unknown> = {
      model: routedModel,
      messages,
      stream: internalReq.stream,
    };

    // 流式请求附加 stream_options 以获取 usage 统计
    if (internalReq.stream) {
      req.stream_options = { include_usage: true };
    }

    // 生成控制参数
    if (internalReq.temperature !== undefined) {
      req.temperature = internalReq.temperature;
    }
    if (internalReq.top_p !== undefined) {
      req.top_p = internalReq.top_p;
    }
    if (internalReq.max_tokens !== undefined) {
      req.max_tokens = internalReq.max_tokens;
    }
    if (internalReq.stop !== undefined) {
      req.stop = internalReq.stop;
    }
    if (internalReq.presence_penalty !== undefined) {
      req.presence_penalty = internalReq.presence_penalty;
    }
    if (internalReq.frequency_penalty !== undefined) {
      req.frequency_penalty = internalReq.frequency_penalty;
    }

    // 工具调用
    if (internalReq.tools) {
      req.tools = normalizeTools(internalReq.tools);
    }
    if (internalReq.tool_choice !== undefined) {
      req.tool_choice = internalReq.tool_choice;
    }

    // 响应格式（Copilot 背后模型支持完整 OpenAI response_format）
    if (internalReq.response_format !== undefined) {
      req.response_format = internalReq.response_format;
    }

    // 终端用户标识
    if (internalReq.user !== undefined) {
      req.user = internalReq.user;
    }

    return req;
  }
}
