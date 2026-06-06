// src/model/http/providers/newapi/chat/request/index.ts — New API 请求适配器
//
// New API 与 OpenAI 完全兼容，映射较直接。
// 特殊处理：
// - reasoning_content_backfill 支持（通过 modelConfig 控制）
// - thinking 配置映射（内部 enabled:boolean → New API type:"enabled"/"disabled"）

import type { ProviderChatRequestAdapter } from '@/model/http/providers/types';
import type { InternalChatRequest, ToolDefinition } from '@/types';
import type { ModelThinkingConfig } from '@/types/common/config';
import { createLogger, GatewayError, logColors } from '@/utils';
import { budgetToEffort } from '@/utils/thinking-budget';
import { normalizeMessages } from './message-converter';

const logger = createLogger('Provider:NewApi', logColors.bold + logColors.magenta);

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
 * New API 聊天请求适配器
 * InternalChatRequest + routedModel → New API 请求体
 *
 * New API 与 OpenAI 兼容，映射较直接。
 * 特殊处理：
 * - thinking 配置映射（内部 enabled:boolean → New API type:"enabled"/"disabled"）
 * - modelConfig 可用于控制 reasoning_content 回填行为
 */
export class NewApiChatRequestAdapter implements ProviderChatRequestAdapter {
  public toProviderRequest(
    internalReq: InternalChatRequest,
    routedModel: string,
    _modelConfig?: Record<string, unknown>,
    thinkingConfig?: ModelThinkingConfig,
  ): Record<string, unknown> {
    logger.debug(
      {
        routedModel,
        messagesCount: internalReq.messages.length,
        hasTools: !!internalReq.tools,
        hasThinking: !!internalReq.thinking,
      },
      'Adapting internal request to New API format',
    );

    // 消息列表导租：由数据自身决定是否携带 reasoning_content
    // thinking_config.reasoning_content_backfill=true 时自动从缓存注入缺失的 reasoning_content
    const messages = normalizeMessages(
      internalReq.messages,
      thinkingConfig?.reasoning_content_backfill === true,
    );

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

    // 思考模式配置：内部 { type: "enabled"/"disabled"/"auto" } → New API { type: "enabled"/"disabled" }
    // New API 不支持 "auto"，将其视为 "enabled"
    if (internalReq.thinking) {
      req.thinking = {
        type: internalReq.thinking.type === 'disabled' ? 'disabled' : 'enabled',
      };
    }

    // 推理强度控制 (reasoning_effort)
    // 仅在配置了 thinking_effort_levels 时生效，未配置则不设置 reasoning_effort
    if (internalReq.thinking?.budget_tokens !== undefined && (internalReq.max_tokens ?? 0) > 0) {
      const effortLevels = thinkingConfig?.levels;
      if (effortLevels && effortLevels.length > 0) {
        const effort = budgetToEffort(
          internalReq.thinking.budget_tokens,
          internalReq.max_tokens as number,
          effortLevels,
        );
        if (effort !== undefined) {
          req.reasoning_effort = effort;
        }
      }
    }

    // 响应格式（JSON mode）
    // New API 仅支持 'text' 和 'json_object'，不支持 'json_schema'
    if (internalReq.response_format !== undefined) {
      if (internalReq.response_format.type === 'json_schema') {
        throw new GatewayError(
          400,
          'unsupported_parameter',
          'New API does not support response_format type "json_schema"; use "json_object" instead',
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
