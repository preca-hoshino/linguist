// src/providers/chat/deepseek/request/index.ts — DeepSeek 请求适配器（精简编排层）

import type { ProviderChatRequestAdapter } from '@/model/http/providers/types';
import type { InternalChatRequest, ToolDefinition } from '@/types';
import { createLogger, GatewayError, logColors } from '@/utils';
import { normalizeMessages, prepareMessagesForReasoner } from './message-converter';

const logger = createLogger('Provider:DeepSeek', logColors.bold + logColors.green);

/**
 * 规范化工具 parameters，确保符合 OpenAI 兼容 API 要求（type: "object"）。
 * 处理 MCP 工具等无参数场景下 parameters 为 null 或 {type: null} 的情况。
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

/** DeepSeek reasoner 模型名称匹配 (支持 v4 系列或旧版 reasoner) */
const REASONER_MODEL_PATTERN = /v4|reasoner/i;

/**
 * DeepSeek 聊天请求适配器
 * InternalChatRequest + routedModel → DeepSeek API 请求体
 *
 * DeepSeek 与 OpenAI 兼容，映射较直接。
 * 特殊处理：
 * - thinking 配置映射（内部 enabled:boolean → DeepSeek type:"enabled"/"disabled"）
 * - reasoner 模型的 assistant 消息必须包含 reasoning_content 字段
 */
export class DeepSeekChatRequestAdapter implements ProviderChatRequestAdapter {
  public toProviderRequest(internalReq: InternalChatRequest, routedModel: string): Record<string, unknown> {
    let isReasoner = REASONER_MODEL_PATTERN.test(routedModel);
    if (internalReq.thinking) {
      isReasoner = internalReq.thinking.type !== 'disabled';
    }

    logger.debug(
      {
        routedModel,
        isReasoner,
        messagesCount: internalReq.messages.length,
        hasTools: !!internalReq.tools,
        hasThinking: !!internalReq.thinking,
      },
      'Adapting internal request to DeepSeek format',
    );

    // reasoner 模型需要特殊处理消息中的 reasoning_content 字段
    // 两条路径均需将 ContentPart[] 内容转换为 OpenAI image_url 格式
    const messages = isReasoner
      ? prepareMessagesForReasoner(internalReq.messages)
      : normalizeMessages(internalReq.messages);

    const req: Record<string, unknown> = {
      model: routedModel,
      messages,
      stream: internalReq.stream,
    };

    // 流式请求时附加 stream_options 以获取 usage 统计
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

    // 思考模式配置：内部 { type: "enabled"/"disabled"/"auto" } → DeepSeek { type: "enabled"/"disabled" }
    // DeepSeek 不支持 "auto"，将其视为 "enabled"
    if (internalReq.thinking) {
      req.thinking = {
        type: internalReq.thinking.type === 'disabled' ? 'disabled' : 'enabled',
      };
    }

    // 推理强度控制 (reasoning_effort)
    // DeepSeek v4 支持作为顶层参数传入
    if (internalReq.reasoning_effort !== undefined) {
      req.reasoning_effort = internalReq.reasoning_effort;
    }

    // 响应格式（JSON mode）
    // DeepSeek 仅支持 'text' 和 'json_object'，不支持 'json_schema'
    if (internalReq.response_format !== undefined) {
      if (internalReq.response_format.type === 'json_schema') {
        throw new GatewayError(
          400,
          'unsupported_parameter',
          'DeepSeek does not support response_format type "json_schema"; use "json_object" instead',
        );
      }
      // 仅传递 type 字段，避免将内部额外字段透传至提供商
      req.response_format = { type: internalReq.response_format.type };
    }

    // 终端用户标识
    if (internalReq.user !== undefined) {
      req.user = internalReq.user;
    }

    return req;
  }
}
