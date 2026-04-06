// src/users/claude/chat/request/index.ts — Anthropic 请求适配器（编排层）

import type { InternalChatRequest, ThinkingConfig, ToolChoice, ToolDefinition } from '@/types';
import type { UserChatRequestAdapter } from '@/users/types';
import { createLogger, GatewayError, logColors } from '@/utils';
import { convertMessages, convertSystemPrompt } from './message-converter';
import type { AnthropicRequestBody, AnthropicTool, AnthropicToolChoice } from './types';

const logger = createLogger('User:Anthropic', logColors.bold + logColors.magenta);

// ==================== 参数校验 ====================

/**
 * 校验 Anthropic 请求参数的类型与取值范围
 *
 * Anthropic 特有的校验规则：
 * - thinking.type=enabled 时必须提供 max_tokens 且 budget_tokens < max_tokens
 * - thinking 开启时 temperature 必须为 1（或不指定）
 */
function validateRequestParams(body: AnthropicRequestBody): void {
  // max_tokens 必须存在且为正整数
  if (typeof body.max_tokens !== 'number' || !Number.isInteger(body.max_tokens) || body.max_tokens <= 0) {
    throw new GatewayError(400, 'invalid_parameter', 'max_tokens is required and must be a positive integer');
  }

  // temperature 范围
  if (
    body.temperature !== undefined &&
    (typeof body.temperature !== 'number' || body.temperature < 0 || body.temperature > 1)
  ) {
    throw new GatewayError(400, 'invalid_parameter', 'temperature must be a number between 0 and 1');
  }

  // top_p 范围
  if (body.top_p !== undefined && (typeof body.top_p !== 'number' || body.top_p < 0 || body.top_p > 1)) {
    throw new GatewayError(400, 'invalid_parameter', 'top_p must be a number between 0 and 1');
  }

  // top_k 范围
  if (body.top_k !== undefined && (typeof body.top_k !== 'number' || !Number.isInteger(body.top_k) || body.top_k < 0)) {
    throw new GatewayError(400, 'invalid_parameter', 'top_k must be a non-negative integer');
  }

  // stop_sequences 类型
  if (
    body.stop_sequences !== undefined &&
    (!Array.isArray(body.stop_sequences) || !body.stop_sequences.every((s) => typeof s === 'string'))
  ) {
    throw new GatewayError(400, 'invalid_parameter', 'stop_sequences must be an array of strings');
  }

  // thinking 校验
  if (body.thinking !== undefined) {
    const t = body.thinking as unknown;
    if (typeof t !== 'object' || t === null || Array.isArray(t)) {
      throw new GatewayError(400, 'invalid_parameter', 'thinking must be an object');
    }
    const { type, budget_tokens } = t as Record<string, unknown>;
    if (type !== 'enabled' && type !== 'disabled' && type !== 'adaptive') {
      throw new GatewayError(
        400,
        'invalid_parameter',
        `thinking.type must be "enabled", "disabled", or "adaptive", got "${String(type)}"`,
      );
    }
    if (type === 'enabled') {
      if (budget_tokens === undefined) {
        throw new GatewayError(400, 'invalid_parameter', 'thinking.budget_tokens is required when thinking is enabled');
      }
      if (typeof budget_tokens !== 'number' || !Number.isInteger(budget_tokens) || budget_tokens <= 0) {
        throw new GatewayError(400, 'invalid_parameter', 'thinking.budget_tokens must be a positive integer');
      }
      if (budget_tokens >= body.max_tokens) {
        throw new GatewayError(
          400,
          'invalid_parameter',
          `thinking.budget_tokens (${budget_tokens}) must be less than max_tokens (${body.max_tokens})`,
        );
      }
      // thinking 开启时 temperature 必须为默认值（1 或不指定）
      if (body.temperature !== undefined && body.temperature !== 1) {
        throw new GatewayError(
          400,
          'invalid_parameter',
          'temperature must be 1 (default) when extended thinking is enabled',
        );
      }
    }
  }

  // messages 必须非空
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new GatewayError(400, 'invalid_request', 'messages must be a non-empty array');
  }

  // stream 类型
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    throw new GatewayError(400, 'invalid_parameter', 'stream must be a boolean');
  }
}

// ==================== 工具转换 ====================

/**
 * Anthropic 工具定义 → 内部 ToolDefinition
 *
 * Anthropic: { name, description, input_schema }
 * 内部:   { type: 'function', function: { name, description, parameters } }
 */
function convertTools(tools: AnthropicTool[]): ToolDefinition[] {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
}

/**
 * Anthropic 工具选择策略 → 内部 ToolChoice
 *
 * Anthropic: { type: 'auto' | 'any' | 'none' | 'tool', name? }
 * 内部:   'auto' | 'none' | 'required' | { type: 'function', function: { name } }
 */
function convertToolChoice(choice: AnthropicToolChoice): ToolChoice {
  switch (choice.type) {
    case 'auto': {
      return 'auto';
    }
    case 'none': {
      return 'none';
    }
    case 'any': {
      return 'required';
    }
    case 'tool': {
      return { type: 'function', function: { name: choice.name } };
    }
    default: {
      return 'auto';
    }
  }
}

// ==================== thinking 转换 ====================

/**
 * Anthropic thinking 配置 → 内部 ThinkingConfig
 */
function convertThinking(thinking: AnthropicRequestBody['thinking']): ThinkingConfig | undefined {
  if (thinking === undefined) {
    return;
  }
  // adaptive 是 Claude Code 新版本引入的自适应思考模式，语义等同 enabled
  const type = thinking.type === 'adaptive' ? 'enabled' : thinking.type;
  return {
    type,
    budget_tokens: thinking.budget_tokens,
  };
}

// ==================== 请求适配器 ====================

export class AnthropicChatRequestAdapter implements UserChatRequestAdapter {
  public toInternal(userReq: unknown): InternalChatRequest {
    const body = userReq as AnthropicRequestBody;

    // 参数校验
    validateRequestParams(body);

    logger.debug(
      {
        messagesCount: body.messages.length,
        stream: body.stream,
        hasTools: body.tools !== undefined,
        hasThinking: body.thinking !== undefined,
        hasSystem: body.system !== undefined,
      },
      'Converting Anthropic chat request to internal format',
    );

    // 转换消息
    const messages = convertMessages(body.messages);

    // 系统提示词：从顶层 system 字段转为 messages 首项
    const systemMessage = convertSystemPrompt(body.system);
    if (systemMessage !== undefined) {
      messages.unshift(systemMessage);
    }

    // 转换 thinking
    const thinking = convertThinking(body.thinking);

    // 转换工具
    const tools = body.tools === undefined ? undefined : convertTools(body.tools);
    const toolChoice = body.tool_choice === undefined ? undefined : convertToolChoice(body.tool_choice);

    return {
      messages,
      stream: body.stream ?? false,
      temperature: body.temperature,
      top_p: body.top_p,
      top_k: body.top_k,
      max_tokens: body.max_tokens,
      stop: body.stop_sequences,
      thinking,
      tools,
      tool_choice: toolChoice,
    };
  }
}
