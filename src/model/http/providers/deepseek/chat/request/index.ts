// src/providers/chat/deepseek/request/index.ts — DeepSeek 请求适配器（精简编排层）

import type { ProviderChatRequestAdapter } from '@/model/http/providers/types';
import type { InternalChatRequest, ToolDefinition } from '@/types';
import { createLogger, GatewayError, logColors } from '@/utils';
import { normalizeMessages } from './message-converter';

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

/**
 * DeepSeek 聊天请求适配器
 * InternalChatRequest + routedModel → DeepSeek API 请求体
 *
 * DeepSeek 与 OpenAI 兼容，映射较直接。
 * 特殊处理：
 * - thinking 配置映射（内部 enabled:boolean → DeepSeek type:"enabled"/"disabled"）
 * - reasoner 模型的 assistant 消息必须包含 reasoning_content 字段
 * - modelConfig 可用于控制 reasoning_content 回填行为
 */
export class DeepSeekChatRequestAdapter implements ProviderChatRequestAdapter {
  public toProviderRequest(
    internalReq: InternalChatRequest,
    routedModel: string,
    modelConfig?: Record<string, unknown>,
  ): Record<string, unknown> {
    logger.debug(
      {
        routedModel,
        messagesCount: internalReq.messages.length,
        hasTools: !!internalReq.tools,
        hasThinking: !!internalReq.thinking,
      },
      'Adapting internal request to DeepSeek format',
    );

    // 消息列表导租：由数据自身决定是否携带 reasoning_content
    // modelConfig.reasoning_content_backfill=true 时自动从缓存注入缺失的 reasoning_content
    const messages = normalizeMessages(internalReq.messages, modelConfig);

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
    // 由统一类型的 thinking.budget_tokens / max_tokens 比率推断，而非直接透传 reasoning_effort 字段。
    // DeepSeek v4 仅支持 'max' 和 'high' 两档。
    // 比率 >= 0.75 → 'max'； >= 0.40 → 'high'；其余 → 不传，由提供商默认处理
    if (internalReq.thinking?.budget_tokens !== undefined && (internalReq.max_tokens ?? 0) > 0) {
      const ratio = internalReq.thinking.budget_tokens / (internalReq.max_tokens as number);
      if (ratio >= 0.75) {
        req.reasoning_effort = 'max';
      } else if (ratio >= 0.4) {
        req.reasoning_effort = 'high';
      }
      // ratio < 0.4：不传该字段
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
