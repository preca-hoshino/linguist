// src/providers/copilot/chat/response/index.ts — Copilot 响应适配器（多端点分支）

import type { ProviderChatResponseAdapter } from '@/providers/types';
import type { FinishReason, InternalChatResponse } from '@/types';
import { createLogger, GatewayError, logColors } from '@/utils';
import { parseAnthropicResponse } from '../fallback/messages';
import { parseResponsesResponse } from '../fallback/responses';
import type { CopilotEndpointType } from '../fallback/types';
import type { CopilotResponse } from './types';

const logger = createLogger('Provider:Copilot', logColors.bold + logColors.cyan);

/** 已知的 finish_reason 值集合 */
const KNOWN_REASONS = new Set<string>(['stop', 'length', 'tool_calls', 'content_filter']);

/**
 * 将 finish_reason 字符串映射到内部统一枚举值
 */
function mapFinishReason(reason: string): FinishReason {
  return KNOWN_REASONS.has(reason) ? (reason as FinishReason) : 'unknown';
}

/**
 * 解析标准 OpenAI ChatCompletions 格式响应（原有逻辑）
 */
function parseOpenAIResponse(providerRes: unknown): InternalChatResponse {
  if (providerRes === undefined || providerRes === null || typeof providerRes !== 'object') {
    throw new GatewayError(502, 'provider_response_invalid', 'Copilot response is not an object');
  }

  const res = providerRes as CopilotResponse;

  if (!Array.isArray(res.choices)) {
    throw new GatewayError(502, 'provider_response_invalid', 'Copilot response missing choices array');
  }

  logger.debug(
    {
      choicesCount: res.choices.length,
      hasUsage: !!res.usage,
      totalTokens: res.usage?.total_tokens,
    },
    'Adapting Copilot response to internal format',
  );

  return {
    choices: res.choices.map((c) => ({
      index: c.index,
      message: {
        role: 'assistant' as const,
        content: c.message.content ?? null,
        tool_calls: c.message.tool_calls,
      },
      finish_reason: mapFinishReason(c.finish_reason),
    })),
    usage: res.usage
      ? {
          prompt_tokens: res.usage.prompt_tokens,
          completion_tokens: res.usage.completion_tokens,
          total_tokens: res.usage.total_tokens,
        }
      : undefined,
  };
}

/**
 * Copilot 聊天响应适配器
 * Copilot API 响应 → InternalChatResponse
 *
 * 通过读取 Client 注入的不可枚举属性 __copilotEndpoint 判断端点类型：
 * - 'messages':  调用 parseAnthropicResponse()
 * - 'responses': 调用 parseResponsesResponse()
 * - 其他/默认:  原有 OpenAI 解析逻辑
 */
export class CopilotChatResponseAdapter implements ProviderChatResponseAdapter {
  public fromProviderResponse(providerRes: unknown): InternalChatResponse {
    const endpoint = (providerRes as Record<string, unknown>).__copilotEndpoint as CopilotEndpointType | undefined;

    switch (endpoint) {
      case 'messages': {
        logger.debug('Parsing Anthropic Messages response');
        return parseAnthropicResponse(providerRes);
      }
      case 'responses': {
        logger.debug('Parsing OpenAI Responses API response');
        return parseResponsesResponse(providerRes);
      }
      default: {
        return parseOpenAIResponse(providerRes);
      }
    }
  }
}
