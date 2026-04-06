// src/users/gemini/chat/response/stream.ts — Gemini 流式响应适配器

import type { GatewayContext, InternalChatStreamChunk } from '@/types';
import type { UserChatStreamResponseAdapter } from '@/users/types';
import { safeParseJson } from '@/utils';
import { convertUsage } from './usage-converter';

// ==================== finishReason 映射 ====================

const FINISH_REASON_MAP: Record<string, string> = {
  stop: 'STOP',
  length: 'MAX_TOKENS',
  tool_calls: 'STOP', // Gemini 不区分 tool_calls，以 STOP + functionCall parts 表达
  content_filter: 'SAFETY',
  unknown: 'STOP',
};

/**
 * Gemini 格式流式响应适配器
 *
 * 将 InternalChatStreamChunk 转为 Gemini SSE 格式：
 *   data: {"candidates":[...],"usageMetadata":{...}}\n\n
 *
 * Gemini 流没有 [DONE] 终止标记，连接关闭时自然结束
 */
export class GeminiChatStreamResponseAdapter implements UserChatStreamResponseAdapter {
  /**
   * 跨 chunk 累积工具调用参数
   * choice_index → (tc_index → { name, arguments })
   *
   * 背景：下游提供商（如 OpenAI/DeepSeek）以增量方式流式传输工具调用参数（arugments 是
   * 逐片拼接的 JSON 字符串），而 Gemini 流式格式要求 functionCall.args 是完整的 JSON
   * 对象。因此需要将所有 delta 累积完毕后，在 finish_reason=tool_calls 的 chunk 一次
   * 性输出完整的 functionCall parts。
   */
  private readonly toolCallBuffers = new Map<number, Map<number, { name: string; arguments: string }>>();

  public formatChunk(_ctx: GatewayContext, chunk: InternalChatStreamChunk): string {
    const obj: Record<string, unknown> = {};

    if (chunk.choices.length > 0) {
      obj.candidates = chunk.choices.map((choice) => {
        const parts: Record<string, unknown>[] = [];
        const delta = choice.delta;

        // 思维链内容 → thought part
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
          parts.push({ text: delta.reasoning_content, thought: true });
        }

        // 文本内容 → text part
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          parts.push({ text: delta.content });
        }

        // 工具调用 delta → 累积，待 finish_reason=tool_calls 时统一输出
        // 原因：下游以增量流式传输 arguments，此处需跨 chunk 拼接完整 JSON 后再解析
        if (delta.tool_calls !== undefined) {
          let buffer = this.toolCallBuffers.get(choice.index);
          if (buffer === undefined) {
            buffer = new Map<number, { name: string; arguments: string }>();
            this.toolCallBuffers.set(choice.index, buffer);
          }

          for (const tc of delta.tool_calls) {
            let entry = buffer.get(tc.index);
            if (entry === undefined) {
              entry = { name: '', arguments: '' };
              buffer.set(tc.index, entry);
            }
            if (tc.function?.name !== undefined && tc.function.name !== '') {
              entry.name = tc.function.name;
            }
            if (tc.function?.arguments !== undefined && tc.function.arguments !== '') {
              entry.arguments += tc.function.arguments;
            }
          }
        }

        // finish_reason=tool_calls 时，将累积的完整参数输出为 functionCall parts
        if (choice.finish_reason === 'tool_calls') {
          const buffer = this.toolCallBuffers.get(choice.index);
          if (buffer !== undefined) {
            for (const [, entry] of buffer) {
              if (entry.name !== '') {
                parts.push({
                  functionCall: {
                    name: entry.name,
                    args: entry.arguments === '' ? {} : safeParseJson(entry.arguments),
                  },
                });
              }
            }
            this.toolCallBuffers.delete(choice.index);
          }
        }

        const candidate: Record<string, unknown> = {};
        if (parts.length > 0) {
          candidate.content = {
            role: 'model',
            parts,
          };
        }

        if (choice.finish_reason !== null) {
          candidate.finishReason = FINISH_REASON_MAP[choice.finish_reason] ?? 'STOP';
        }

        return candidate;
      });
    }

    if (chunk.usage) {
      obj.usageMetadata = convertUsage(chunk.usage);
    }

    // 只输出非空 chunk
    if (Object.keys(obj).length === 0) {
      return '';
    }

    return `data: ${JSON.stringify(obj)}\n\n`;
  }
  public formatEnd(): string | null {
    return null; // Gemini 不使用 [DONE] 终止标记
  }
}
