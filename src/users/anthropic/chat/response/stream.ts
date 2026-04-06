// src/users/claude/chat/response/stream.ts — Anthropic 流式响应适配器（per-request 状态机）

import type { ChatUsage, GatewayContext, InternalChatStreamChunk } from '@/types';
import type { UserChatStreamResponseAdapter } from '@/users/types';
import { v4 as uuidv4 } from '@/utils/uuid';
import { convertUsage } from './usage-converter';

/** 生成虚假签名 */
function generateDummySignature(): string {
  return `erUgSig_${uuidv4()}`;
}

/**
 * 当前正在输出的内容块类型
 * - idle: 尚未输出任何内容块
 * - thinking: 正在输出思考过程
 * - text: 正在输出文本回复
 * - tool_use: 正在输出工具调用
 */
type BlockState = 'idle' | 'thinking' | 'text' | 'tool_use';

/** 每个请求的独立状态 */
interface StreamState {
  blockState: BlockState;
  blockIndex: number;
  messageStarted: boolean;
  lastUsage: ChatUsage | undefined;
  stopReason: string | null;
}

/**
 * Anthropic 流式响应适配器
 *
 * Anthropic SSE 拥有严格的块生命周期事件机制，不能像 OpenAI 那样简单透传 delta。
 * 必须按顺序输出以下事件序列：
 *
 * 1. event: message_start     — 流开始，携带完整的 message 骨架
 * 2. event: content_block_start — 新内容块开始（thinking / text / tool_use）
 * 3. event: content_block_delta — 增量内容（thinking_delta / text_delta / input_json_delta）
 * 4. event: content_block_stop  — 当前内容块结束
 * 5. event: message_delta      — 流末尾，携带 stop_reason 和 usage
 * 6. event: message_stop       — 流彻底结束
 *
 * 本适配器使用 per-request 状态（按 ctx.id 隔离），保证并发安全。
 */
export class AnthropicChatStreamResponseAdapter implements UserChatStreamResponseAdapter {
  /**
   * 按请求 ID 隔离的状态表
   * 使用 Map 而非实例字段，保证单例注册下多请求并发互不干扰
   */
  private readonly states = new Map<string, StreamState>();

  /** 获取或初始化请求专属状态 */
  private getState(requestId: string): StreamState {
    let state = this.states.get(requestId);
    if (state === undefined) {
      state = {
        blockState: 'idle',
        blockIndex: 0,
        messageStarted: false,
        lastUsage: undefined,
        stopReason: null,
      };
      this.states.set(requestId, state);
    }
    return state;
  }

  /** 清理已完成请求的状态，防止内存泄漏 */
  private cleanupState(requestId: string): void {
    this.states.delete(requestId);
  }

  public formatChunk(ctx: GatewayContext, chunk: InternalChatStreamChunk): string {
    const state = this.getState(ctx.id);
    const lines: string[] = [];
    const choice = chunk.choices[0];

    // 暂存 usage
    if (chunk.usage !== undefined) {
      state.lastUsage = chunk.usage;
    }

    if (choice === undefined) {
      return '';
    }

    const { delta, finish_reason } = choice;

    // 1. 首次 chunk → 发送 message_start
    if (!state.messageStarted) {
      lines.push(this.emitMessageStart(ctx));
      state.messageStarted = true;
    }

    // 2. 处理 reasoning_content（思考增量）
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
      if (state.blockState !== 'thinking') {
        if (state.blockState !== 'idle') {
          lines.push(this.emitBlockStop(state));
        }
        lines.push(this.emitBlockStart(state, 'thinking'));
        state.blockState = 'thinking';
      }
      lines.push(this.emitThinkingDelta(state, delta.reasoning_content));
    }

    // 3. 处理 content（文本增量）
    if (typeof delta.content === 'string' && delta.content !== '') {
      if (state.blockState !== 'text') {
        if (state.blockState !== 'idle') {
          lines.push(this.emitBlockStop(state));
        }
        lines.push(this.emitBlockStart(state, 'text'));
        state.blockState = 'text';
      }
      lines.push(this.emitTextDelta(state, delta.content));
    }

    // 4. 处理 tool_calls（工具调用增量）
    if (delta.tool_calls !== undefined && delta.tool_calls.length > 0) {
      for (const tc of delta.tool_calls) {
        if (tc.id !== undefined) {
          if (state.blockState !== 'idle') {
            lines.push(this.emitBlockStop(state));
          }
          lines.push(this.emitToolUseBlockStart(state, tc.id, tc.function?.name ?? ''));
          state.blockState = 'tool_use';
        }
        if (typeof tc.function?.arguments === 'string' && tc.function.arguments !== '') {
          lines.push(this.emitToolInputDelta(state, tc.function.arguments));
        }
      }
    }

    // 5. finish_reason → 关闭当前块 + 发送 message_delta + message_stop
    if (finish_reason !== null) {
      state.stopReason = this.mapFinishReason(finish_reason);

      if (state.blockState !== 'idle') {
        lines.push(this.emitBlockStop(state));
        state.blockState = 'idle';
      }

      lines.push(this.emitMessageDelta(state), this.emitMessageStop());

      // 流结束，清理状态
      this.cleanupState(ctx.id);
    }

    return lines.join('');
  }

  public formatEnd(): string | null {
    // Anthropic SSE 不使用 [DONE] 标记，message_stop 就是终止信号
    return null;
  }

  // ==================== 事件生成器 ====================

  private emitMessageStart(ctx: GatewayContext): string {
    const data = {
      type: 'message_start',
      message: {
        id: `msg_${ctx.id}`,
        type: 'message',
        role: 'assistant',
        content: [],
        model: ctx.requestModel,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    };
    return `event: message_start\ndata: ${JSON.stringify(data)}\n\n`;
  }

  private emitBlockStart(state: StreamState, type: 'thinking' | 'text'): string {
    const index = state.blockIndex;
    const contentBlock: Record<string, unknown> =
      type === 'thinking'
        ? { type: 'thinking', thinking: '', signature: generateDummySignature() }
        : { type: 'text', text: '' };

    const data = {
      type: 'content_block_start',
      index,
      content_block: contentBlock,
    };
    return `event: content_block_start\ndata: ${JSON.stringify(data)}\n\n`;
  }

  private emitToolUseBlockStart(state: StreamState, id: string, name: string): string {
    const index = state.blockIndex;
    const data = {
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id, name, input: {} },
    };
    return `event: content_block_start\ndata: ${JSON.stringify(data)}\n\n`;
  }

  private emitBlockStop(state: StreamState): string {
    const data = {
      type: 'content_block_stop',
      index: state.blockIndex,
    };
    state.blockIndex++;
    return `event: content_block_stop\ndata: ${JSON.stringify(data)}\n\n`;
  }

  private emitThinkingDelta(state: StreamState, thinking: string): string {
    const data = {
      type: 'content_block_delta',
      index: state.blockIndex,
      delta: { type: 'thinking_delta', thinking },
    };
    return `event: content_block_delta\ndata: ${JSON.stringify(data)}\n\n`;
  }

  private emitTextDelta(state: StreamState, text: string): string {
    const data = {
      type: 'content_block_delta',
      index: state.blockIndex,
      delta: { type: 'text_delta', text },
    };
    return `event: content_block_delta\ndata: ${JSON.stringify(data)}\n\n`;
  }

  private emitToolInputDelta(state: StreamState, partialJson: string): string {
    const data = {
      type: 'content_block_delta',
      index: state.blockIndex,
      delta: { type: 'input_json_delta', partial_json: partialJson },
    };
    return `event: content_block_delta\ndata: ${JSON.stringify(data)}\n\n`;
  }

  private emitMessageDelta(state: StreamState): string {
    const data = {
      type: 'message_delta',
      delta: { stop_reason: state.stopReason ?? 'end_turn', stop_sequence: null },
      usage: convertUsage(state.lastUsage),
    };
    return `event: message_delta\ndata: ${JSON.stringify(data)}\n\n`;
  }

  private emitMessageStop(): string {
    return `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`;
  }

  // ==================== finish_reason 映射 ====================

  private mapFinishReason(reason: string): string {
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
      default: {
        return 'end_turn';
      }
    }
  }
}
