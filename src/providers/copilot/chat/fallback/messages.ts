// src/providers/copilot/chat/fallback/messages.ts — OpenAI ChatCompletions → Anthropic Messages 双向翻译器
//
// 注意：此翻译器的输入是 OpenAI ChatCompletions Payload（Record<string, unknown>），
// 而非 InternalChatRequest。这是因为 engine.ts 管线固定先调用 RequestAdapter，
// 再调用 Client，Client 收到的是已经过 RequestAdapter 转换的 OpenAI 格式负载。
// 参见 implementation_plan.md § 2.4 "最终方案"

import type { FinishReason, InternalChatResponse, InternalChatStreamChunk, ToolCall, ToolCallDelta } from '@/types';
import type {
  AnthropicContentBlock,
  AnthropicContentBlockDeltaEvent,
  AnthropicContentBlockStartEvent,
  AnthropicMessage,
  AnthropicMessageDeltaEvent,
  AnthropicMessageStartEvent,
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicStreamState,
  AnthropicTool,
  AnthropicToolChoice,
} from './types';

// ==================== OpenAI → Anthropic 请求转换 ====================

/**
 * 将 OpenAI messages 格式转换为 Anthropic messages 格式
 * - system 消息提取为独立的 system 参数
 * - tool 消息转为 user 消息（tool_result 内容块）
 * - 工具调用 (tool_calls) 转为 tool_use 内容块
 */
function translateMessages(openAiMessages: unknown[]): {
  system: string | undefined;
  messages: AnthropicMessage[];
} {
  let system: string | undefined;
  const messages: AnthropicMessage[] = [];

  for (const rawMsg of openAiMessages) {
    const msg = rawMsg as Record<string, unknown>;
    const role = msg.role as string;
    const content = msg.content;
    const toolCalls = msg.tool_calls as
      | Array<{
          id: string;
          type: string;
          function: { name: string; arguments: string };
        }>
      | undefined;
    const toolCallId = msg.tool_call_id as string | undefined;

    if (role === 'system') {
      // Anthropic 只支持单个 system，多个 system 消息拼接
      const text = typeof content === 'string' ? content : '';
      system = system !== undefined ? `${system}\n\n${text}` : text;
      continue;
    }

    if (role === 'tool') {
      // tool 结果转为 user 消息中的 tool_result 块
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolCallId ?? '',
            content: typeof content === 'string' ? content : '',
          },
        ],
      });
      continue;
    }

    if (role === 'assistant') {
      const blocks: AnthropicContentBlock[] = [];

      // 文本内容
      if (typeof content === 'string' && content.length > 0) {
        blocks.push({ type: 'text', text: content });
      } else if (Array.isArray(content)) {
        for (const part of content as Record<string, unknown>[]) {
          if (part.type === 'text' && typeof part.text === 'string') {
            blocks.push({ type: 'text', text: part.text });
          }
        }
      }

      // 工具调用
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          let parsedInput: Record<string, unknown> = {};
          try {
            parsedInput = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          } catch {
            // 无法解析时使用空对象
          }
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: parsedInput,
          });
        }
      }

      messages.push({
        role: 'assistant',
        content: blocks.length === 1 && blocks[0]?.type === 'text' ? (blocks[0] as { text: string }).text : blocks,
      });
      continue;
    }

    if (role === 'user') {
      if (typeof content === 'string') {
        messages.push({ role: 'user', content });
      } else if (Array.isArray(content)) {
        const blocks: AnthropicContentBlock[] = [];
        for (const part of content as Record<string, unknown>[]) {
          if (part.type === 'text' && typeof part.text === 'string') {
            blocks.push({ type: 'text', text: part.text });
          } else if (part.type === 'image_url') {
            const imageUrl = part.image_url as Record<string, unknown>;
            const url = imageUrl.url as string;
            if (url.startsWith('data:')) {
              const [mimeInfo, base64Data] = url.split(',');
              const mimeType = (mimeInfo?.split(';')[0]?.replace('data:', '') ?? 'image/jpeg').trim();
              blocks.push({
                type: 'image',
                source: { type: 'base64', media_type: mimeType, data: base64Data ?? '' },
              });
            } else {
              blocks.push({ type: 'image', source: { type: 'url', url } });
            }
          }
        }
        messages.push({ role: 'user', content: blocks });
      }
    }
  }

  return { system, messages };
}

/**
 * 将 OpenAI tools 格式转换为 Anthropic tools 格式
 */
function translateTools(openAiTools: unknown[]): AnthropicTool[] {
  return openAiTools.map((rawTool) => {
    const tool = rawTool as Record<string, unknown>;
    const fn = tool.function as Record<string, unknown>;
    const params = (fn.parameters ?? { type: 'object', properties: {} }) as {
      type?: string;
      properties?: Record<string, unknown>;
      required?: string[];
      [key: string]: unknown;
    };

    return {
      name: fn.name as string,
      ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
      input_schema: {
        ...params,
        type: 'object' as const,
      },
    } satisfies AnthropicTool;
  });
}

/**
 * 将 OpenAI tool_choice 转换为 Anthropic tool_choice
 */
function translateToolChoice(toolChoice: unknown): AnthropicToolChoice | undefined {
  if (toolChoice === 'auto' || toolChoice === undefined || toolChoice === null) {
    return { type: 'auto' };
  }
  if (toolChoice === 'required') {
    return { type: 'any' };
  }
  if (toolChoice === 'none') {
    return undefined;
  }
  if (typeof toolChoice === 'object') {
    const tc = toolChoice as Record<string, unknown>;
    if (tc.type === 'function' && typeof tc.function === 'object') {
      const fn = tc.function as Record<string, unknown>;
      return { type: 'tool', name: fn.name as string };
    }
  }
  return { type: 'auto' };
}

/**
 * 将 OpenAI ChatCompletions Payload 转换为 Anthropic Messages Payload
 * 入参为已经过 RequestAdapter 转换的 OpenAI 格式负载
 */
export function translateChatToAnthropicPayload(openAiPayload: Record<string, unknown>): AnthropicMessagesPayload {
  const messages = Array.isArray(openAiPayload.messages) ? openAiPayload.messages : [];
  const { system, messages: anthropicMessages } = translateMessages(messages);

  const payload: AnthropicMessagesPayload = {
    model: openAiPayload.model as string,
    messages: anthropicMessages,
    max_tokens: typeof openAiPayload.max_tokens === 'number' ? openAiPayload.max_tokens : 4096,
    stream: openAiPayload.stream === true,
  };

  if (system !== undefined) {
    payload.system = system;
  }

  if (typeof openAiPayload.temperature === 'number') {
    payload.temperature = openAiPayload.temperature;
  }

  if (typeof openAiPayload.top_p === 'number') {
    payload.top_p = openAiPayload.top_p;
  }

  if (Array.isArray(openAiPayload.stop)) {
    payload.stop_sequences = openAiPayload.stop as string[];
  } else if (typeof openAiPayload.stop === 'string') {
    payload.stop_sequences = [openAiPayload.stop];
  }

  if (Array.isArray(openAiPayload.tools) && openAiPayload.tools.length > 0) {
    payload.tools = translateTools(openAiPayload.tools);
    if (openAiPayload.tool_choice !== undefined) {
      const translated = translateToolChoice(openAiPayload.tool_choice);
      if (translated !== undefined) {
        payload.tool_choice = translated;
      }
    }
  }

  return payload;
}

// ==================== Anthropic → Internal 响应转换 ====================

/**
 * 将 Anthropic stop_reason 映射到内部 FinishReason
 */
function mapAnthropicStopReason(reason: string | null): FinishReason {
  switch (reason) {
    case 'end_turn': {
      return 'stop';
    }
    case 'tool_use': {
      return 'tool_calls';
    }
    case 'max_tokens': {
      return 'length';
    }
    case 'stop_sequence': {
      return 'stop';
    }
    default: {
      return 'stop';
    }
  }
}

/**
 * 将 Anthropic 完整响应转换为 InternalChatResponse
 */
export function parseAnthropicResponse(providerRes: unknown): InternalChatResponse {
  const res = providerRes as AnthropicResponse;

  let textContent: string | null = null;
  const toolCalls: ToolCall[] = [];

  for (const block of res.content) {
    if (block.type === 'text') {
      textContent = textContent !== null ? `${textContent}${block.text}` : block.text;
    } else {
      // block.type === 'tool_use'
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      });
    }
  }

  return {
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: textContent,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        },
        finish_reason: mapAnthropicStopReason(res.stop_reason),
      },
    ],
    usage: {
      prompt_tokens: res.usage.input_tokens,
      completion_tokens: res.usage.output_tokens,
      total_tokens: res.usage.input_tokens + res.usage.output_tokens,
    },
  };
}

// ==================== Anthropic 流式 SSE → Internal chunk 转换 ====================

/**
 * 创建 Anthropic 流式翻译状态机初始状态
 */
export function createAnthropicStreamState(): AnthropicStreamState {
  return {
    toolCallIndexToId: new Map(),
    toolCallIndexToName: new Map(),
    roleEmitted: false,
    stopReason: null,
    inputTokens: 0,
  };
}

/**
 * 将单条 Anthropic SSE 事件转换为 InternalChatStreamChunk
 */
export function parseAnthropicStreamChunk(chunk: unknown, state: AnthropicStreamState): InternalChatStreamChunk {
  const event = chunk as Record<string, unknown>;
  const eventType = event.type as string;

  switch (eventType) {
    case 'message_start': {
      const ev = event as unknown as AnthropicMessageStartEvent;
      state.inputTokens = ev.message.usage.input_tokens;
      state.roleEmitted = true;
      return {
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: '' },
            finish_reason: null,
          },
        ],
      };
    }

    case 'content_block_start': {
      const ev = event as unknown as AnthropicContentBlockStartEvent;
      if (ev.content_block.type === 'tool_use') {
        state.toolCallIndexToId.set(ev.index, ev.content_block.id);
        state.toolCallIndexToName.set(ev.index, ev.content_block.name);
        const toolDelta: ToolCallDelta = {
          index: ev.index,
          id: ev.content_block.id,
          type: 'function',
          function: { name: ev.content_block.name, arguments: '' },
        };
        return {
          choices: [
            {
              index: 0,
              delta: { tool_calls: [toolDelta] },
              finish_reason: null,
            },
          ],
        };
      }
      return { choices: [{ index: 0, delta: {}, finish_reason: null }] };
    }

    case 'content_block_delta': {
      const ev = event as unknown as AnthropicContentBlockDeltaEvent;
      if (ev.delta.type === 'text_delta') {
        const textDelta = ev.delta;
        return {
          choices: [
            {
              index: 0,
              delta: { content: textDelta.text },
              finish_reason: null,
            },
          ],
        };
      } else {
        // ev.delta.type === 'input_json_delta'
        const jsonDelta = ev.delta;
        const toolDelta: ToolCallDelta = {
          index: ev.index,
          function: { arguments: jsonDelta.partial_json },
        };
        return {
          choices: [
            {
              index: 0,
              delta: { tool_calls: [toolDelta] },
              finish_reason: null,
            },
          ],
        };
      }
    }

    case 'content_block_stop': {
      return { choices: [{ index: 0, delta: {}, finish_reason: null }] };
    }

    case 'message_delta': {
      const ev = event as unknown as AnthropicMessageDeltaEvent;
      state.stopReason = ev.delta.stop_reason;
      return {
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: mapAnthropicStopReason(ev.delta.stop_reason),
          },
        ],
        usage: {
          prompt_tokens: state.inputTokens,
          completion_tokens: ev.usage.output_tokens,
          total_tokens: state.inputTokens + ev.usage.output_tokens,
        },
      };
    }

    default: {
      return { choices: [{ index: 0, delta: {}, finish_reason: null }] };
    }
  }
}
