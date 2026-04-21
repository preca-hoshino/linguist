// src/users/openaicompat/chat/response/stream.ts — OpenAI 兼容流式响应适配器

import type { UserChatStreamResponseAdapter } from '@/model/http/users/types';
import type { ChatStreamDelta, InternalChatStreamChunk, ModelHttpContext } from '@/types';
import { convertUsage } from './usage-converter';

/**
 * OpenAI 格式流式响应适配器
 *
 * 将 InternalChatStreamChunk 转为 OpenAI SSE 格式：
 *   data: {"id":"...","object":"chat.completion.chunk","created":...,"model":"...","choices":[...]}\n\n
 *
 * 流结束时发送：
 *   data: [DONE]\n\n
 */
export class OpenAICompatChatStreamResponseAdapter implements UserChatStreamResponseAdapter {
  public formatChunk(ctx: ModelHttpContext, chunk: InternalChatStreamChunk): string {
    const obj: Record<string, unknown> = {
      id: ctx.id,
      object: 'chat.completion.chunk',
      created: Math.floor(ctx.timing.start / 1000),
      model: ctx.requestModel,
      choices: chunk.choices.map((choice) => ({
        index: choice.index,
        delta: this.convertDelta(choice.delta),
        finish_reason: choice.finish_reason,
      })),
    };

    if (chunk.usage) {
      obj.usage = convertUsage(chunk.usage);
    }

    return `data: ${JSON.stringify(obj)}\n\n`;
  }

  public formatEnd(): string | null {
    return 'data: [DONE]\n\n';
  }

  /**
   * 转换内部 delta 为 OpenAI 格式
   * 仅包含有值的字段，避免发送多余内容
   */
  private convertDelta(delta: ChatStreamDelta): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    if (delta.role !== undefined) {
      result.role = delta.role;
    }
    if (delta.content !== undefined) {
      result.content = delta.content;
    }
    if (delta.reasoning_content !== undefined) {
      result.reasoning_content = delta.reasoning_content;
    }
    if (delta.tool_calls !== undefined) {
      result.tool_calls = delta.tool_calls;
    }
    return result;
  }
}
