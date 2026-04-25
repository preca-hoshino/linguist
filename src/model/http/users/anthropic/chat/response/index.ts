// src/users/claude/chat/response/index.ts — Anthropic 非流式响应适配器

import type { UserChatResponseAdapter } from '@/model/http/users/types';
import type { FinishReason, InternalChatResponse, ModelHttpContext } from '@/types';
import { createLogger, logColors } from '@/utils';
import { v4 as uuidv4 } from '@/utils/uuid';
import { convertUsage } from './usage-converter';

const logger = createLogger('User:Anthropic', logColors.bold + logColors.magenta);

/** 生成虚假签名 — 后端不是真实 Anthropic，签名仅用于骗过客户端 SDK 的格式校验 */
function generateDummySignature(): string {
  return `erUgSig_${uuidv4()}`;
}

// ==================== finish_reason 映射 ====================

/**
 * 内部 FinishReason → Anthropic stop_reason
 *
 * | 内部           | Anthropic       |
 * | -------------- | ------------ |
 * | stop           | end_turn     |
 * | length         | max_tokens   |
 * | tool_calls     | tool_use     |
 * | content_filter | end_turn     |
 * | unknown        | end_turn     |
 */
function mapFinishReason(reason: FinishReason): string {
  switch (reason) {
    case 'stop': {
      return 'end_turn';
    }
    case 'length': {
      return 'max_tokens';
    }
    case 'tool_calls': {
      return 'tool_use';
    }
    case 'content_filter':
    case 'insufficient_system_resource':
    case 'unknown': {
      return 'end_turn';
    }
  }
}

// ==================== 响应适配器 ====================

/**
 * 从 ModelHttpContext 组装 Anthropic Messages API 非流式响应
 *
 * Anthropic 响应结构:
 * {
 *   id: "msg_...",
 *   type: "message",
 *   role: "assistant",
 *   content: [ { type: "thinking", ... }, { type: "text", text: "..." }, { type: "tool_use", ... } ],
 *   model: "...",
 *   stop_reason: "end_turn" | "max_tokens" | "tool_use",
 *   usage: { input_tokens, output_tokens }
 * }
 */
export class AnthropicChatResponseAdapter implements UserChatResponseAdapter {
  public fromInternal(ctx: ModelHttpContext): Record<string, unknown> {
    const res = ctx.response as InternalChatResponse;
    const choice = res.choices[0];

    logger.debug(
      {
        requestId: ctx.id,
        hasUsage: res.usage !== undefined,
        model: ctx.requestModel,
      },
      'Converting internal response to Anthropic format',
    );

    if (!choice) {
      return this.buildEmptyMessage(ctx, res);
    }

    // 组装 content 数组
    const content: Record<string, unknown>[] = [];

    // 1. thinking 块（如果有 reasoning_content）
    if (typeof choice.message.reasoning_content === 'string' && choice.message.reasoning_content.length > 0) {
      content.push({
        type: 'thinking',
        thinking: choice.message.reasoning_content,
        signature: generateDummySignature(),
      });
    }

    // 2. 文本块
    if (typeof choice.message.content === 'string' && choice.message.content.length > 0) {
      content.push({
        type: 'text',
        text: choice.message.content,
      });
    }

    // 3. tool_use 块
    if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
      for (const tc of choice.message.tool_calls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: this.safeParseJson(tc.function.arguments),
        });
      }
    }

    // 确保 content 至少有一个空文本块
    if (content.length === 0) {
      content.push({ type: 'text', text: '' });
    }

    return {
      id: `msg_${ctx.id}`,
      type: 'message',
      role: 'assistant',
      content,
      model: ctx.requestModel,
      stop_reason: mapFinishReason(choice.finish_reason),
      stop_sequence: null,
      usage: convertUsage(res.usage),
    };
  }

  /** 空响应兜底 */
  private buildEmptyMessage(ctx: ModelHttpContext, res: InternalChatResponse): Record<string, unknown> {
    return {
      id: `msg_${ctx.id}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: '' }],
      model: ctx.requestModel,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: convertUsage(res.usage),
    };
  }

  /** 安全解析 JSON 字符串，失败时返回原始字符串包装 */
  private safeParseJson(jsonStr: string): Record<string, unknown> {
    try {
      return JSON.parse(jsonStr) as Record<string, unknown>;
    } catch {
      return { raw: jsonStr };
    }
  }
}
