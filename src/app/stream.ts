// src/app/stream.ts — 流式数据传输与 chunks 合并

import type { Response } from 'express';
import type {
  GatewayContext,
  InternalChatRequest,
  InternalChatResponse,
  InternalChatStreamChunk,
  ChatChoice,
  ChatUsage,
  ToolCall,
  FinishReason,
} from '../types';
import { getUserChatAdapter } from '../users';
import { dispatchChatProviderStream } from '../providers/caller';
import { assertRouted } from '../router';
import { expressHeadersToRecord } from './helpers';
import { normalizeStreamChunkToolCallIds } from '../utils';
import type { Middleware } from '../middleware';
import { applyMiddlewares } from '../middleware';

// ========== 流式发送阶段（chat 专属） ==========

/**
 * 流式数据传输阶段
 *
 * 调用前提：ctx 已完成路由（assertRouted 保证字段完整）。
 * 职责单一：建连 → 发头 → 逐 chunk 写入 → 结束标记。
 * 不处理错误 —— 异常向上传播，由外层统一 catch 负责收尾。
 *
 * 注意：res.writeHead 发送后响应头已提交，外层 catch 会检测
 * res.headersSent 并仅执行 res.end() 而非发送错误 JSON。
 */
export async function processStreamSend(ctx: GatewayContext, res: Response, middlewares: Middleware[]): Promise<void> {
  assertRouted(ctx);
  const { streamResponse: userStreamAdapter } = getUserChatAdapter(ctx.userFormat);

  // 建立流式连接（此阶段仍可 failover，响应头尚未发送）
  const { stream } = await dispatchChatProviderStream(ctx, ctx.request as InternalChatRequest);

  // 响应头发送后不能再写入错误 JSON
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // 禁用 nginx 缓冲
  });

  // 累积 chunks 用于审计日志
  const providerChunks: InternalChatStreamChunk[] = [];
  let ttftRecorded = false;

  for await (const rawChunk of stream) {
    // 对提供商响应中的工具调用 ID 进行 UUID v5 规范化
    const chunk = normalizeStreamChunkToolCallIds(rawChunk);
    providerChunks.push(chunk);

    // 首 Token 到达时间（TTFT）：首个携带实际内容增量的 chunk
    if (!ttftRecorded) {
      const hasContent = chunk.choices.some(
        (c) =>
          (c.delta.content !== undefined && c.delta.content !== '') ||
          (c.delta.reasoning_content !== undefined && c.delta.reasoning_content !== '') ||
          (c.delta.tool_calls !== undefined && c.delta.tool_calls.length > 0),
      );
      if (hasContent) {
        ctx.timing.ttft = Date.now();
        ttftRecorded = true;
      }
    }

    const line = userStreamAdapter.formatChunk(ctx, chunk);
    if (line.length > 0) {
      res.write(line);
    }
  }

  const terminator = userStreamAdapter.formatEnd();
  if (terminator !== null) {
    res.write(terminator);
  }
  res.end();

  // 将流式 chunks 合并为完整响应，写入审计字段
  ctx.response = mergeStreamChunks(providerChunks);

  // 响应中间件链（对流式路径，规范化中间件在 chunk 已单独处理故为 no-op）
  await applyMiddlewares(ctx, middlewares);

  // 流式审计：将 provider 和 user 的响应体均转为等价非流式 JSON
  // providerResponse.body = 合并后的 InternalChatResponse（非流式内部格式）
  if (ctx.audit.providerResponse !== undefined) {
    ctx.audit.providerResponse.body = ctx.response;
  } else {
    ctx.audit.providerResponse = { body: ctx.response };
  }
  // userResponse.body = 用户格式非流式响应（与非流式路径完全一致）
  const userNonStreamAdapter = getUserChatAdapter(ctx.userFormat);
  ctx.audit.userResponse = {
    headers: expressHeadersToRecord(res.getHeaders()),
    body: userNonStreamAdapter.response.fromInternal(ctx),
  };
  ctx.timing.responseAdapted = Date.now();
}

// ========== 流式 chunks 合并 ==========

/**
 * 将流式 InternalChatStreamChunk 数组合并为等价的 InternalChatResponse
 * 用于：
 * - ctx.response — extractUsage 提取 token 统计
 * - gateway_context 快照中保留完整响应视图
 */
export function mergeStreamChunks(chunks: InternalChatStreamChunk[]): InternalChatResponse {
  // 提取 usage（通常仅最后一个有效 chunk 携带）
  let usage: ChatUsage | undefined;

  // 按 choice.index 累积增量
  const accMap = new Map<
    number,
    {
      content: string;
      reasoning_content: string;
      finish_reason: FinishReason;
      toolCalls: Map<number, { id: string; name: string; arguments: string }>;
    }
  >();

  for (const chunk of chunks) {
    if (chunk.usage !== undefined) {
      usage = chunk.usage;
    }
    for (const choice of chunk.choices) {
      let acc = accMap.get(choice.index);
      if (acc === undefined) {
        acc = { content: '', reasoning_content: '', finish_reason: 'unknown', toolCalls: new Map() };
        accMap.set(choice.index, acc);
      }
      if (typeof choice.delta.content === 'string') {
        acc.content += choice.delta.content;
      }
      if (typeof choice.delta.reasoning_content === 'string') {
        acc.reasoning_content += choice.delta.reasoning_content;
      }
      if (choice.finish_reason !== null) {
        acc.finish_reason = choice.finish_reason;
      }
      if (choice.delta.tool_calls !== undefined) {
        for (const tc of choice.delta.tool_calls) {
          let toolAcc = acc.toolCalls.get(tc.index);
          if (toolAcc === undefined) {
            toolAcc = { id: '', name: '', arguments: '' };
            acc.toolCalls.set(tc.index, toolAcc);
          }
          if (tc.id !== undefined) {
            toolAcc.id = tc.id;
          }
          if (tc.function?.name !== undefined) {
            toolAcc.name = tc.function.name;
          }
          if (tc.function?.arguments !== undefined) {
            toolAcc.arguments += tc.function.arguments;
          }
        }
      }
    }
  }

  // 组装最终 choices
  const choices: ChatChoice[] = [...accMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, acc]): ChatChoice => {
      const toolCalls: ToolCall[] = [...acc.toolCalls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, tc]) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments },
        }));

      return {
        index,
        message: {
          role: 'assistant' as const,
          content: acc.content.length > 0 ? acc.content : null,
          ...(acc.reasoning_content.length > 0 ? { reasoning_content: acc.reasoning_content } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: acc.finish_reason,
      };
    });

  return { choices, usage };
}
