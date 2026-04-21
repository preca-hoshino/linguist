// src/users/openaicompat/chat/request/index.ts — OpenAI 兼容请求适配器（精简编排层）

import type { UserChatRequestAdapter } from '@/model/http/users/types';
import type { InternalChatRequest, ThinkingConfig } from '@/types';
import { GatewayError } from '@/utils/errors';
import { createLogger, logColors } from '@/utils/logger';
import { convertMessages } from './message-converter';
import type { OpenAICompatChatRequestBody, OpenAICompatReasoningEffort } from './types';

const logger = createLogger('User:OpenAICompat', logColors.bold + logColors.cyan);

// ==================== 合法枚举集合 ====================

const VALID_THINKING_TYPES = new Set(['enabled', 'disabled', 'auto']);
const VALID_REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high']);
const VALID_ROLES = new Set(['system', 'user', 'assistant', 'tool']);
const VALID_RESPONSE_FORMAT_TYPES = new Set(['text', 'json_object', 'json_schema']);
const VALID_TOOL_CHOICE_STRINGS = new Set(['auto', 'none', 'required']);

// ==================== reasoning_effort → ThinkingConfig 转换 ====================

/** reasoning_effort 级别对应 max_tokens 的百分比（从该百分比计算 Gemini budget_tokens） */
const REASONING_EFFORT_RATIO: Record<Exclude<OpenAICompatReasoningEffort, 'minimal'>, number> = {
  low: 0.2,
  medium: 0.5,
  high: 0.8,
};

/**
 * 合并 thinking 配置与 reasoning_effort
 *
 * 规则：
 * 1. reasoning_effort = 'minimal' → 强制关闭，返回 { type: 'disabled' }
 * 2. thinking 已提供：直接使用；若缺少 budget_tokens 且有 reasoning_effort + max_tokens，用百分比补充
 * 3. 仅 reasoning_effort (non-minimal)：初始化 { type: 'enabled' } 并计算 budget_tokens
 *
 * 优先级：thinking.budget_tokens > reasoning_effort 百分比计算
 */
function resolveThinking(
  thinking?: ThinkingConfig,
  reasoningEffort?: OpenAICompatReasoningEffort,
  maxTokens?: number,
): ThinkingConfig | undefined {
  // minimal 关闭思考，居最高优先级
  if (reasoningEffort === 'minimal') {
    return { type: 'disabled' };
  }

  if (thinking) {
    // thinking 已提供；若缺少 budget_tokens 且有可用的 reasoning_effort + max_tokens，用百分比补充
    if (thinking.budget_tokens === undefined && reasoningEffort && maxTokens !== undefined) {
      return {
        ...thinking,
        budget_tokens: Math.round(maxTokens * REASONING_EFFORT_RATIO[reasoningEffort]),
      };
    }
    return thinking;
  }

  if (reasoningEffort) {
    const budgetTokens =
      maxTokens === undefined ? undefined : Math.round(maxTokens * REASONING_EFFORT_RATIO[reasoningEffort]);
    return { type: 'enabled', budget_tokens: budgetTokens };
  }

  return;
}

// ==================== 参数范围校验 ====================

/**
 * 校验所有请求参数的类型与取值范围
 *
 * 非法值直接抛出 400 错误，防止无效参数透传至提供商暴露内部细节。
 * 此函数是运行时类型守卫的唯一入口，弥补 TypeScript 编译期类型约束在 JSON 输入时的缺失。
 */
function validateRequestParams(body: OpenAICompatChatRequestBody): void {
  // --- 数值范围 ---
  if (
    body.temperature !== undefined &&
    (typeof body.temperature !== 'number' || body.temperature < 0 || body.temperature > 2)
  ) {
    throw new GatewayError(400, 'invalid_parameter', 'temperature must be a number between 0 and 2');
  }
  if (body.top_p !== undefined && (typeof body.top_p !== 'number' || body.top_p < 0 || body.top_p > 1)) {
    throw new GatewayError(400, 'invalid_parameter', 'top_p must be a number between 0 and 1');
  }
  if (body.top_k !== undefined && (typeof body.top_k !== 'number' || !Number.isInteger(body.top_k) || body.top_k < 0)) {
    throw new GatewayError(400, 'invalid_parameter', 'top_k must be a non-negative integer');
  }
  if (
    body.max_tokens !== undefined &&
    (typeof body.max_tokens !== 'number' || !Number.isInteger(body.max_tokens) || body.max_tokens <= 0)
  ) {
    throw new GatewayError(400, 'invalid_parameter', 'max_tokens must be a positive integer');
  }
  if (
    body.presence_penalty !== undefined &&
    (typeof body.presence_penalty !== 'number' || body.presence_penalty < -2 || body.presence_penalty > 2)
  ) {
    throw new GatewayError(400, 'invalid_parameter', 'presence_penalty must be a number between -2 and 2');
  }
  if (
    body.frequency_penalty !== undefined &&
    (typeof body.frequency_penalty !== 'number' || body.frequency_penalty < -2 || body.frequency_penalty > 2)
  ) {
    throw new GatewayError(400, 'invalid_parameter', 'frequency_penalty must be a number between -2 and 2');
  }

  // --- thinking 对象校验（最常见的客户端错误：传字符串而非对象） ---
  if (body.thinking !== undefined) {
    const t = body.thinking as unknown;
    if (typeof t !== 'object' || t === null || Array.isArray(t)) {
      throw new GatewayError(
        400,
        'invalid_parameter',
        `thinking must be an object with type: "enabled" | "disabled" | "auto", got ${typeof t}`,
      );
    }
    const { type, budget_tokens } = t as Record<string, unknown>;
    if (!VALID_THINKING_TYPES.has(type as string)) {
      throw new GatewayError(
        400,
        'invalid_parameter',
        `thinking.type must be one of: "enabled", "disabled", "auto", got "${String(type)}"`,
      );
    }
    if (
      budget_tokens !== undefined &&
      (typeof budget_tokens !== 'number' || !Number.isInteger(budget_tokens) || budget_tokens < 0)
    ) {
      throw new GatewayError(400, 'invalid_parameter', 'thinking.budget_tokens must be a non-negative integer');
    }
  }

  // --- reasoning_effort 枚举值 ---
  if (body.reasoning_effort !== undefined && !VALID_REASONING_EFFORTS.has(body.reasoning_effort as string)) {
    throw new GatewayError(
      400,
      'invalid_parameter',
      `reasoning_effort must be one of: "minimal", "low", "medium", "high", got "${body.reasoning_effort}"`,
    );
  }

  // --- stop 类型 ---
  if (body.stop !== undefined) {
    const isValidStop =
      typeof body.stop === 'string' || (Array.isArray(body.stop) && body.stop.every((s) => typeof s === 'string'));
    if (!isValidStop) {
      throw new GatewayError(400, 'invalid_parameter', 'stop must be a string or an array of strings');
    }
  }

  // --- messages 字段级校验 ---
  if (Array.isArray(body.messages)) {
    for (let i = 0; i < body.messages.length; i++) {
      const msg = body.messages[i] as unknown as Record<string, unknown>;
      if (!VALID_ROLES.has(msg.role as string)) {
        throw new GatewayError(
          400,
          'invalid_parameter',
          `messages[${i}].role must be one of: "system", "user", "assistant", "tool", got "${String(msg.role)}"`,
        );
      }
    }
  }

  // --- response_format 类型枚举 ---
  if (body.response_format !== undefined) {
    const rf = body.response_format as unknown;
    if (typeof rf !== 'object' || rf === null || Array.isArray(rf)) {
      throw new GatewayError(400, 'invalid_parameter', 'response_format must be an object');
    }
    const { type } = rf as Record<string, unknown>;
    if (!VALID_RESPONSE_FORMAT_TYPES.has(type as string)) {
      throw new GatewayError(
        400,
        'invalid_parameter',
        `response_format.type must be one of: "text", "json_object", "json_schema"`,
      );
    }
  }

  // --- tool_choice 类型 ---
  if (body.tool_choice !== undefined) {
    const tc = body.tool_choice as unknown;
    const isStringChoice = typeof tc === 'string' && VALID_TOOL_CHOICE_STRINGS.has(tc);
    const isObjectChoice =
      typeof tc === 'object' &&
      tc !== null &&
      !Array.isArray(tc) &&
      (tc as Record<string, unknown>).type === 'function';
    if (!isStringChoice && !isObjectChoice) {
      throw new GatewayError(
        400,
        'invalid_parameter',
        'tool_choice must be "auto", "none", "required", or a function object { type: "function", function: { name } }',
      );
    }
  }

  // --- user 类型 ---
  if (body.user !== undefined && typeof body.user !== 'string') {
    throw new GatewayError(400, 'invalid_parameter', 'user must be a string');
  }

  // --- stream 类型 ---
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    throw new GatewayError(400, 'invalid_parameter', 'stream must be a boolean');
  }
}

export class OpenAICompatChatRequestAdapter implements UserChatRequestAdapter {
  public toInternal(userReq: unknown): InternalChatRequest {
    if (userReq === undefined || userReq === null || typeof userReq !== 'object') {
      throw new GatewayError(400, 'invalid_request', 'Chat request must include a non-empty messages array');
    }
    const body = userReq as OpenAICompatChatRequestBody;
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      throw new GatewayError(400, 'invalid_request', 'Chat request must include a non-empty messages array');
    }

    // 参数范围校验（在适配之前拦截，避免非法值透传到提供商）
    validateRequestParams(body);

    logger.debug(
      {
        messagesCount: body.messages.length,
        stream: body.stream,
        hasTools: !!body.tools,
        hasThinking: !!body.thinking,
        reasoningEffort: body.reasoning_effort,
      },
      'Converting OpenAICompat chat request to internal format',
    );

    const messages = convertMessages(body.messages);
    const thinking = resolveThinking(body.thinking, body.reasoning_effort, body.max_tokens);

    // reasoning_effort 透传至内部（minimal 已转为 thinking.type='disabled'，无需再传）
    const reasoningEffort =
      body.reasoning_effort !== undefined && body.reasoning_effort !== 'minimal' ? body.reasoning_effort : undefined;

    return {
      messages,
      stream: body.stream ?? false,
      temperature: body.temperature,
      top_p: body.top_p,
      top_k: body.top_k,
      max_tokens: body.max_tokens,
      stop: body.stop,
      presence_penalty: body.presence_penalty,
      frequency_penalty: body.frequency_penalty,
      thinking,
      reasoning_effort: reasoningEffort,
      tools: body.tools,
      tool_choice: body.tool_choice,
      response_format: body.response_format,
      user: body.user,
    };
  }
}
