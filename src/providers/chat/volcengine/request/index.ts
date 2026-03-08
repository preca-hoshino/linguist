// src/providers/chat/volcengine/request/index.ts — 火山引擎请求适配器（精简编排层）

import type { ProviderChatRequestAdapter } from '../../interface';
import type { InternalChatRequest, ToolDefinition } from '../../../../types';
import { convertMessages } from './message-converter';
import { createLogger, logColors, GatewayError } from '../../../../utils';

const logger = createLogger('Provider:VolcEngine', logColors.bold + logColors.magenta);

/**
 * 规范化工具 parameters，确保符合 OpenAI 兼容 API 要求（type: "object"）。
 * 处理 MCP 工具等无参数场景下 parameters 为 null 或 {type: null} 的情况。
 */
function normalizeToolParameters(parameters: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!parameters || typeof parameters !== 'object') {
    return { type: 'object', properties: {} };
  }
  if (parameters['type'] === null || parameters['type'] === 'null') {
    return {
      type: 'object',
      properties: {},
      ...Object.fromEntries(Object.entries(parameters).filter(([k]) => k !== 'type')),
    };
  }
  if (parameters['type'] !== 'object') {
    return { ...parameters, type: 'object', ...(parameters['properties'] === undefined ? { properties: {} } : {}) };
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
 * 火山引擎聊天请求适配器
 * InternalChatRequest + routedModel → 火山引擎 API 请求体
 *
 * 火山引擎 API 兼容 OpenAI 格式，映射较直接。
 * 特殊处理：
 * - 多模态内容转换：内部 MediaContentPart → image_url 格式
 * - thinking 配置映射：内部 enabled:boolean → 火山引擎 type:"enabled"/"disabled"
 * - top_k 支持：火山引擎额外支持 top_k 参数
 */
export class VolcEngineChatRequestAdapter implements ProviderChatRequestAdapter {
  public toProviderRequest(internalReq: InternalChatRequest, routedModel: string): Record<string, unknown> {
    logger.debug(
      {
        routedModel,
        messagesCount: internalReq.messages.length,
        hasTools: !!internalReq.tools,
        hasThinking: !!internalReq.thinking,
      },
      'Adapting internal request to VolcEngine format',
    );

    // 消息转换（含多模态 image → image_url）
    const messages = convertMessages(internalReq.messages);

    const req: Record<string, unknown> = {
      model: routedModel,
      messages,
      stream: internalReq.stream,
    };

    // 流式请求时附加 stream_options 以获取 usage 统计
    if (internalReq.stream) {
      req['stream_options'] = { include_usage: true };
    }

    // 生成控制参数
    if (internalReq.temperature !== undefined) {
      req['temperature'] = internalReq.temperature;
    }
    if (internalReq.top_p !== undefined) {
      req['top_p'] = internalReq.top_p;
    }
    if (internalReq.top_k !== undefined) {
      req['top_k'] = internalReq.top_k;
    }
    if (internalReq.max_tokens !== undefined) {
      req['max_tokens'] = internalReq.max_tokens;
    }
    if (internalReq.stop !== undefined) {
      req['stop'] = internalReq.stop;
    }

    // 惩罚参数
    if (internalReq.presence_penalty !== undefined) {
      req['presence_penalty'] = internalReq.presence_penalty;
    }
    if (internalReq.frequency_penalty !== undefined) {
      req['frequency_penalty'] = internalReq.frequency_penalty;
    }

    // 工具调用
    if (internalReq.tools) {
      req['tools'] = normalizeTools(internalReq.tools);
    }
    if (internalReq.tool_choice !== undefined) {
      req['tool_choice'] = internalReq.tool_choice;
    }

    // 思考模式配置：内部 { type: "enabled"/"disabled"/"auto" } 直接透传至火山引擎
    if (internalReq.thinking) {
      req['thinking'] = {
        type: internalReq.thinking.type,
      };
    }

    // 推理努力级别（火山引擎独有参数，与 thinking 配合使用）
    if (internalReq.reasoning_effort !== undefined) {
      req['reasoning_effort'] = internalReq.reasoning_effort;
    }

    // 响应格式（JSON mode）
    // 火山引擎仅支持 'text' 和 'json_object'，不支持 'json_schema'
    if (internalReq.response_format !== undefined) {
      if (internalReq.response_format.type === 'json_schema') {
        throw new GatewayError(
          400,
          'unsupported_parameter',
          'VolcEngine does not support response_format type "json_schema"; use "json_object" instead',
        );
      }
      // 仅传递 type 字段，避免将内部额外字段透传至提供商
      req['response_format'] = { type: internalReq.response_format.type };
    }

    // 终端用户标识
    if (internalReq.user !== undefined) {
      req['user'] = internalReq.user;
    }

    return req;
  }
}
