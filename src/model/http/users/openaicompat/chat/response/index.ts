// src/users/openaicompat/chat/response/index.ts — OpenAI 兼容响应适配器（精简编排层）

import type { GatewayContext, InternalChatResponse } from '@/types';
import type { UserChatResponseAdapter } from '@/model/http/users/types';
import { createLogger, logColors } from '@/utils';
import { convertUsage } from './usage-converter';

const logger = createLogger('User:OpenAICompat', logColors.bold + logColors.cyan);

/**
 * 从 GatewayContext 组装 OpenAI 格式聊天响应
 * id、model、created 均从 ctx 获取，而非从 InternalChatResponse
 */
export class OpenAICompatChatResponseAdapter implements UserChatResponseAdapter {
  public fromInternal(ctx: GatewayContext): Record<string, unknown> {
    const res = ctx.response as InternalChatResponse;
    logger.debug(
      {
        requestId: ctx.id,
        choicesCount: res.choices.length,
        hasUsage: !!res.usage,
        model: ctx.requestModel,
      },
      'Converting internal response to OpenAI format',
    );

    return {
      id: ctx.id,
      object: 'chat.completion',
      created: Math.floor(ctx.timing.start / 1000),
      model: ctx.requestModel,
      choices: res.choices.map((choice) => this.convertChoice(choice)),
      usage: convertUsage(res.usage),
    };
  }

  /**
   * 将内部 choice 转换为 OpenAI 格式
   *
   * 核心修复：当 content 为空但 reasoning_content 有值时，
   * 将 reasoning_content 回填到 content，避免客户端主内容区空白。
   * 这处理了 DeepSeek R1 返回 content:null 或 Gemini 思考模型
   * 所有 parts 标记为 thought:true 的场景。
   */
  private convertChoice(choice: InternalChatResponse['choices'][number]): Record<string, unknown> {
    const { message, index, finish_reason } = choice;

    const hasReasoning = typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0;

    const msg: Record<string, unknown> = {
      role: message.role,
      content: message.content,
    };

    // 透传 reasoning_content，让客户端展示思考过程
    if (hasReasoning) {
      msg.reasoning_content = message.reasoning_content;
    }

    // 仅在存在 tool_calls 时包含
    if (message.tool_calls && message.tool_calls.length > 0) {
      msg.tool_calls = message.tool_calls;
    }

    return { index, message: msg, finish_reason };
  }
}
