// src/providers/mimo/chat/request/index.ts — MiMo 请求适配器

import type { ProviderChatRequestAdapter } from '@/model/http/providers/types';
import type { InternalChatRequest, ToolDefinition } from '@/types';
import { createLogger, GatewayError, logColors } from '@/utils';
import { normalizeMessages } from './message-converter';

const logger = createLogger('Provider:MiMo', logColors.bold + logColors.blue);

/**
 * 规范化工具 parameters，确保符合 OpenAI 兼容 API 要求（type: "object"）。
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
 * MiMo 聊天请求适配器
 * InternalChatRequest + routedModel → MiMo API 请求体
 *
 * MiMo API 兼容 OpenAI 格式，关键差异：
 * - max_tokens → max_completion_tokens（字段名不同）
 * - thinking 仅支持 enabled/disabled（不支持 auto）
 * - response_format 仅支持 text / json_object（不支持 json_schema）
 * - 不支持 top_k / reasoning_effort
 *
 * ⚠️ 每个参数都显式判断后添加，不盲目透传。
 */
export class MiMoChatRequestAdapter implements ProviderChatRequestAdapter {
  public toProviderRequest(
    internalReq: InternalChatRequest,
    routedModel: string,
    _modelConfig?: Record<string, unknown>,
    _thinkingEffortLevels?: import('@/types').ThinkingEffortLevel[],
  ): Record<string, unknown> {
    logger.debug(
      {
        routedModel,
        messagesCount: internalReq.messages.length,
        hasTools: !!internalReq.tools,
        hasThinking: !!internalReq.thinking,
        stream: internalReq.stream,
      },
      'Adapting internal request to MiMo format',
    );

    const messages = normalizeMessages(internalReq.messages);

    const req: Record<string, unknown> = {
      model: routedModel,
      messages,
      stream: internalReq.stream,
    };

    // 流式请求时附加 stream_options 以获取 usage 统计
    if (internalReq.stream) {
      req.stream_options = { include_usage: true };
    }

    // ── 生成控制参数（逐个显式判断） ──────────────────────────────────

    // temperature：采样温度，MiMo 支持 [0, 1.5]
    if (internalReq.temperature !== undefined) {
      req.temperature = internalReq.temperature;
    }

    // top_p：核采样概率阈值，MiMo 支持 [0.01, 1.0]
    if (internalReq.top_p !== undefined) {
      req.top_p = internalReq.top_p;
    }

    // max_tokens → max_completion_tokens：MiMo 专用字段名
    if (internalReq.max_tokens !== undefined) {
      req.max_completion_tokens = internalReq.max_tokens;
    }

    // stop：停止序列，MiMo Chat 模型支持（TTS 模型不支持，由 supported_parameters 剥离）
    if (internalReq.stop !== undefined) {
      req.stop = internalReq.stop;
    }

    // presence_penalty：存在惩罚 [-2.0, 2.0]
    if (internalReq.presence_penalty !== undefined) {
      req.presence_penalty = internalReq.presence_penalty;
    }

    // frequency_penalty：频率惩罚 [-2.0, 2.0]
    if (internalReq.frequency_penalty !== undefined) {
      req.frequency_penalty = internalReq.frequency_penalty;
    }

    // ── 工具调用 ──────────────────────────────────────────────────────

    if (internalReq.tools != null && internalReq.tools.length > 0) {
      req.tools = normalizeTools(internalReq.tools);
    }

    // tool_choice：MiMo 仅支持 auto 且可能被后端移除，但仍透传
    if (internalReq.tool_choice !== undefined) {
      req.tool_choice = internalReq.tool_choice;
    }

    // ── 思考模式 ──────────────────────────────────────────────────────
    // MiMo 仅支持 enabled / disabled，不支持 auto（将 auto 视为 enabled）
    if (internalReq.thinking !== undefined) {
      if (internalReq.thinking.type === 'disabled') {
        req.thinking = { type: 'disabled' };
      } else {
        // enabled 或 auto → enabled
        req.thinking = { type: 'enabled' };
      }
    }

    // ── 响应格式 ──────────────────────────────────────────────────────
    // MiMo 仅支持 text 和 json_object，不支持 json_schema
    if (internalReq.response_format !== undefined) {
      if (internalReq.response_format.type === 'json_schema') {
        throw new GatewayError(
          400,
          'unsupported_parameter',
          'MiMo does not support response_format type "json_schema"; use "json_object" instead',
        );
      }
      req.response_format = { type: internalReq.response_format.type };
    }

    // ── 终端用户标识 ──────────────────────────────────────────────────

    if (internalReq.user !== undefined) {
      req.user = internalReq.user;
    }

    // 注意：以下参数 MiMo 不支持，不传递
    // - top_k（MiMo 无此概念）
    // - reasoning_effort（MiMo reasoning 由 thinking.type 控制）

    return req;
  }
}
