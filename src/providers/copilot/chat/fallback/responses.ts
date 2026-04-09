// src/providers/copilot/chat/fallback/responses.ts — OpenAI ChatCompletions → Responses API 双向翻译器
//
// 注意：同 messages.ts，入参为 OpenAI ChatCompletions Payload
// （已经过 RequestAdapter 转换的格式），而非 InternalChatRequest。
// 参见 implementation_plan.md § 2.4 "最终方案"

import type { FinishReason, InternalChatResponse, InternalChatStreamChunk, ToolCall, ToolCallDelta } from '@/types';
import type {
  ResponsesCompletedEvent,
  ResponsesFunctionCallDeltaEvent,
  ResponsesFunctionCallDoneEvent,
  ResponsesFunctionTool,
  ResponsesInputMessage,
  ResponsesOutputItemDoneEvent,
  ResponsesOutputTextDeltaEvent,
  ResponsesPayload,
  ResponsesResult,
  ResponsesStreamState,
  ResponsesToolChoice,
} from './types';

// ==================== OpenAI → Responses API 请求转换 ====================

/**
 * 将 OpenAI messages 格式转换为 Responses API input 格式
 * - system 消息转为 instructions 参数
 * - tool 结果消息转换为 function_call_output 类型（由 Responses API 用户消息承载）
 */
function translateMessages(openAiMessages: unknown[]): {
  instructions: string | undefined;
  input: ResponsesInputMessage[];
} {
  let instructions: string | undefined;
  const input: ResponsesInputMessage[] = [];

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

    if (role === 'system' || role === 'developer') {
      const text = typeof content === 'string' ? content : '';
      instructions = instructions !== undefined ? `${instructions}\n\n${text}` : text;
      continue;
    }

    if (role === 'user') {
      if (typeof content === 'string') {
        input.push({ role: 'user', content });
      } else if (Array.isArray(content)) {
        const parts = (content as Record<string, unknown>[])
          .map((part) => {
            if (part.type === 'text' && typeof part.text === 'string') {
              return { type: 'input_text' as const, text: part.text };
            }
            if (part.type === 'image_url') {
              const imageUrl = part.image_url as Record<string, unknown>;
              return { type: 'input_image' as const, image_url: imageUrl.url as string };
            }
            return null;
          })
          .filter((p): p is NonNullable<typeof p> => p !== null);
        if (parts.length > 0) {
          input.push({ role: 'user', content: parts });
        }
      }
      continue;
    }

    if (role === 'assistant') {
      const blocks: string[] = [];

      if (typeof content === 'string' && content.length > 0) {
        blocks.push(content);
      }

      // 助手消息中的工具调用仅保留文本内容
      // Responses API 通过独立的函数调用轮次处理工具返回
      if (Array.isArray(toolCalls)) {
        // 工具调用历史在 Responses API 中以不同方式处理，此处仅转换文本部分
        for (const tc of toolCalls) {
          // Responses API 不支持嵌套式历史工具调用，复原为助手文本回复
          blocks.push(`[Function call: ${tc.function.name}(${tc.function.arguments})]`);
        }
      }

      input.push({
        role: 'assistant',
        content: blocks.join('\n'),
      });
      continue;
    }

    if (role === 'tool') {
      // tool 结果消息在 Responses API 中作为 user 消息处理
      const toolCallId = msg.tool_call_id as string | undefined;
      const resultContent = typeof content === 'string' ? content : JSON.stringify(content);
      input.push({
        role: 'user',
        content: `[Tool result for ${toolCallId ?? 'unknown'}: ${resultContent}]`,
      });
    }
  }

  return { instructions, input };
}

/**
 * 将 OpenAI tools 格式转换为 Responses API tools 格式
 */
function translateTools(openAiTools: unknown[]): ResponsesFunctionTool[] {
  return openAiTools.map((rawTool) => {
    const tool = rawTool as Record<string, unknown>;
    const fn = tool.function as Record<string, unknown>;
    const params = fn.parameters as Record<string, unknown> | undefined;

    return {
      type: 'function' as const,
      name: fn.name as string,
      ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
      ...(params !== undefined ? { parameters: params } : {}),
    } satisfies ResponsesFunctionTool;
  });
}

/**
 * 将 OpenAI tool_choice 转换为 Responses API tool_choice
 */
function translateToolChoice(toolChoice: unknown): ResponsesToolChoice | undefined {
  if (toolChoice === 'auto' || toolChoice === undefined || toolChoice === null) {
    return 'auto';
  }
  if (toolChoice === 'required') {
    return 'required';
  }
  if (toolChoice === 'none') {
    return 'none';
  }
  if (typeof toolChoice === 'object') {
    const tc = toolChoice as Record<string, unknown>;
    if (tc.type === 'function' && typeof tc.function === 'object') {
      const fn = tc.function as Record<string, unknown>;
      return { type: 'function', name: fn.name as string };
    }
  }
  return 'auto';
}

/**
 * 将 OpenAI ChatCompletions Payload 转换为 Responses API 请求负载
 * 入参为已经过 RequestAdapter 转换的 OpenAI 格式负载
 */
export function translateChatToResponsesPayload(openAiPayload: Record<string, unknown>): ResponsesPayload {
  const messages = Array.isArray(openAiPayload.messages) ? openAiPayload.messages : [];
  const { instructions, input } = translateMessages(messages);

  const payload: ResponsesPayload = {
    model: openAiPayload.model as string,
    input,
    stream: openAiPayload.stream === true,
  };

  if (instructions !== undefined) {
    payload.instructions = instructions;
  }

  if (typeof openAiPayload.max_tokens === 'number') {
    payload.max_output_tokens = openAiPayload.max_tokens;
  }

  if (typeof openAiPayload.temperature === 'number') {
    payload.temperature = openAiPayload.temperature;
  }

  if (typeof openAiPayload.top_p === 'number') {
    payload.top_p = openAiPayload.top_p;
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

// ==================== Responses API → Internal 响应转换 ====================

/**
 * 将 Responses API status 映射到内部 FinishReason
 */
function mapResponsesStatus(status: string): FinishReason {
  switch (status) {
    case 'completed': {
      return 'stop';
    }
    case 'incomplete': {
      return 'length';
    }
    default: {
      return 'stop';
    }
  }
}

/**
 * 将 Responses API 完整响应转换为 InternalChatResponse
 */
export function parseResponsesResponse(providerRes: unknown): InternalChatResponse {
  const res = providerRes as ResponsesResult;

  let textContent: string | null = null;
  const toolCalls: ToolCall[] = [];

  for (const outputItem of res.output) {
    // ResponsesResult.output 目前只包含 ResponsesOutputMessage (type: 'message')
    const itemContent = outputItem.content;
    for (const block of itemContent) {
      if ('text' in block) {
        // output_text 块
        textContent = textContent !== null ? `${textContent}${block.text}` : block.text;
      } else if ('call_id' in block) {
        // function_call 块
        toolCalls.push({
          id: block.call_id,
          type: 'function',
          function: {
            name: block.name,
            arguments: block.arguments,
          },
        });
      }
    }
  }

  // 从第一个输出消息的状态推断 finish_reason
  const firstOutput = res.output[0];
  const finishReason: FinishReason =
    firstOutput !== undefined ? mapResponsesStatus(firstOutput.status) : mapResponsesStatus(res.status);

  return {
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: textContent,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        },
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : finishReason,
      },
    ],
    usage: {
      prompt_tokens: res.usage.input_tokens,
      completion_tokens: res.usage.output_tokens,
      total_tokens: res.usage.total_tokens,
    },
  };
}

// ==================== Responses 流式 SSE → Internal chunk 转换 ====================

/**
 * 创建 Responses 流式翻译状态机初始状态
 */
export function createResponsesStreamState(): ResponsesStreamState {
  return {
    functionCallIndexToCallId: new Map(),
    functionCallIndexToName: new Map(),
    started: false,
  };
}

/**
 * 将单条 Responses API SSE 事件转换为 InternalChatStreamChunk
 */
export function parseResponsesStreamChunk(chunk: unknown, state: ResponsesStreamState): InternalChatStreamChunk {
  const event = chunk as Record<string, unknown>;
  const eventType = event.type as string;

  if (eventType === 'response.created') {
    state.started = true;
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

  if (eventType === 'response.output_text.delta') {
    const ev = event as unknown as ResponsesOutputTextDeltaEvent;
    return {
      choices: [
        {
          index: 0,
          delta: { content: ev.delta },
          finish_reason: null,
        },
      ],
    };
  }

  if (eventType === 'response.output_item.done') {
    const ev = event as unknown as ResponsesOutputItemDoneEvent;
    // 函数调用完成，发出所有工具调用 delta
    const toolCalls: ToolCallDelta[] = [];
    for (const block of ev.item.content) {
      if ('call_id' in block) {
        toolCalls.push({
          index: ev.output_index,
          id: block.call_id,
          type: 'function',
          function: { name: block.name, arguments: block.arguments },
        });
      }
    }
    if (toolCalls.length > 0) {
      return {
        choices: [
          {
            index: 0,
            delta: { tool_calls: toolCalls },
            finish_reason: null,
          },
        ],
      };
    }
    return { choices: [{ index: 0, delta: {}, finish_reason: null }] };
  }

  if (eventType === 'response.function_call_arguments.delta') {
    const ev = event as unknown as ResponsesFunctionCallDeltaEvent;
    // 注册 call_id 到 state
    if (!state.functionCallIndexToCallId.has(ev.output_index)) {
      state.functionCallIndexToCallId.set(ev.output_index, ev.call_id);
    }
    const toolDelta: ToolCallDelta = {
      index: ev.output_index,
      function: { arguments: ev.delta },
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

  if (eventType === 'response.function_call_arguments.done') {
    const ev = event as unknown as ResponsesFunctionCallDoneEvent;
    state.functionCallIndexToCallId.set(ev.output_index, ev.call_id);
    return { choices: [{ index: 0, delta: {}, finish_reason: null }] };
  }

  if (eventType === 'response.completed') {
    const ev = event as unknown as ResponsesCompletedEvent;
    const usage = ev.response.usage;
    const hasFunctionCalls = ev.response.output.some((item) => item.content.some((b) => 'call_id' in b));
    return {
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: hasFunctionCalls ? 'tool_calls' : 'stop',
        },
      ],
      usage: {
        prompt_tokens: usage.input_tokens,
        completion_tokens: usage.output_tokens,
        total_tokens: usage.total_tokens,
      },
    };
  }

  // 其他事件（rate_limits.updated, response.output_item.added 等）忽略
  return { choices: [{ index: 0, delta: {}, finish_reason: null }] };
}
