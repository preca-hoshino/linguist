// src/users/chat/openaicompat/request/index.ts — OpenAI 兼容请求适配器（精简编排层）

import type { UserChatRequestAdapter } from '../../interface';
import type { InternalChatRequest, ThinkingConfig } from '../../../../types';
import type { OpenAICompatChatRequestBody, OpenAICompatReasoningEffort } from './types';
import { convertMessages } from './message-converter';
import { GatewayError, createLogger, logColors } from '../../../../utils';

const logger = createLogger('User:OpenAICompat', logColors.bold + logColors.cyan);

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
      maxTokens !== undefined ? Math.round(maxTokens * REASONING_EFFORT_RATIO[reasoningEffort]) : undefined;
    return { type: 'enabled', budget_tokens: budgetTokens };
  }

  return undefined;
}

// ==================== 参数范围校验 ====================

/**
 * 校验生成控制参数的取值范围
 * 非法值直接抛出 400 错误，防止无效参数透传至提供商暴露内部细节
 */
function validateGenerationParams(body: OpenAICompatChatRequestBody): void {
  if (body.temperature !== undefined && (body.temperature < 0 || body.temperature > 2)) {
    throw new GatewayError(400, 'invalid_parameter', 'temperature must be between 0 and 2');
  }
  if (body.top_p !== undefined && (body.top_p < 0 || body.top_p > 1)) {
    throw new GatewayError(400, 'invalid_parameter', 'top_p must be between 0 and 1');
  }
  if (body.max_tokens !== undefined && body.max_tokens <= 0) {
    throw new GatewayError(400, 'invalid_parameter', 'max_tokens must be a positive integer');
  }
  if (body.presence_penalty !== undefined && (body.presence_penalty < -2 || body.presence_penalty > 2)) {
    throw new GatewayError(400, 'invalid_parameter', 'presence_penalty must be between -2 and 2');
  }
  if (body.frequency_penalty !== undefined && (body.frequency_penalty < -2 || body.frequency_penalty > 2)) {
    throw new GatewayError(400, 'invalid_parameter', 'frequency_penalty must be between -2 and 2');
  }
}

export class OpenAICompatChatRequestAdapter implements UserChatRequestAdapter {
  public toInternal(userReq: unknown): InternalChatRequest {
    const body = userReq as OpenAICompatChatRequestBody;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (typeof body !== 'object' || body === null || !Array.isArray(body.messages) || body.messages.length === 0) {
      throw new GatewayError(400, 'invalid_request', 'Chat request must include a non-empty messages array');
    }

    // 参数范围校验（在适配之前拦截，避免非法值透传到提供商）
    validateGenerationParams(body);

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
