// src/providers/chat/gemini/response/stream.ts — Gemini 流式响应适配器

import type { ProviderChatStreamResponseAdapter } from '../../interface';
import type { InternalChatStreamChunk, FinishReason, ToolCallDelta } from '../../../../types';
import type { GeminiResponse } from './types';
import { convertUsage } from './usage-converter';

// ==================== finishReason 映射 ====================

const FINISH_REASON_MAP: Record<string, FinishReason> = {
  STOP: 'stop',
  MAX_TOKENS: 'length',
  SAFETY: 'content_filter',
  RECITATION: 'content_filter',
};

// ==================== 适配器实现 ====================

/**
 * Gemini 流式响应适配器
 *
 * Gemini SSE 流的每个 chunk 结构与非流式 GeminiResponse 相同（candidates + usageMetadata），
 * 区别在于每个 chunk 只包含增量 parts，而非完整 candidate。
 *
 * 转换策略：
 * - 每个 candidate 的 parts 拆分为文本、思维链、函数调用三类
 * - 函数调用在 Gemini 流中以完整 functionCall part 出现（非增量 delta）
 * - usageMetadata 通常仅在最后一个 chunk 中出现
 */
export class GeminiChatStreamResponseAdapter implements ProviderChatStreamResponseAdapter {
  public fromProviderStreamChunk(providerChunk: unknown): InternalChatStreamChunk {
    const res = providerChunk as GeminiResponse;
    const candidates = res.candidates ?? [];

    return {
      choices: candidates.map((candidate, idx) => {
        const parts = candidate.content?.parts ?? [];

        let content: string | undefined;
        let reasoningContent: string | undefined;
        const toolCallDeltas: ToolCallDelta[] = [];
        let toolCallCounter = 0;

        for (const part of parts) {
          // 思维链内容（Gemini thinking 特性）
          if (part.thought && part.text !== undefined) {
            reasoningContent = (reasoningContent ?? '') + part.text;
            continue;
          }

          // 函数调用（Gemini 流式中以完整 functionCall 出现）
          if (part.functionCall) {
            toolCallDeltas.push({
              index: toolCallCounter,
              id: `call_${idx}_${Date.now()}_${toolCallCounter}`,
              type: 'function',
              function: {
                name: part.functionCall.name,
                arguments: JSON.stringify(part.functionCall.args),
              },
            });
            toolCallCounter++;
            continue;
          }

          // 普通文本
          if (part.text !== undefined) {
            content = (content ?? '') + part.text;
          }
        }

        const hasToolCalls = toolCallDeltas.length > 0;
        let finishReason: FinishReason | null = null;
        if (candidate.finishReason !== undefined && candidate.finishReason !== '') {
          // Gemini 流式怪癖：每个 chunk 都携带 finishReason（通常为 "STOP"），
          // 但仅最终 chunk 的 finishReason 有语义。通过 usageMetadata 判断是否为最终 chunk。
          // 非 STOP 原因（SAFETY / MAX_TOKENS 等）始终立即传播，因为它们表示异常终止。
          if (candidate.finishReason !== 'STOP' || res.usageMetadata !== undefined) {
            finishReason = hasToolCalls ? 'tool_calls' : (FINISH_REASON_MAP[candidate.finishReason] ?? 'unknown');
          }
        }

        return {
          index: idx,
          delta: {
            role: candidate.content?.role === 'model' ? ('assistant' as const) : undefined,
            content,
            reasoning_content: reasoningContent,
            tool_calls: hasToolCalls ? toolCallDeltas : undefined,
          },
          finish_reason: finishReason,
        };
      }),
      usage: convertUsage(res.usageMetadata),
    };
  }
}
