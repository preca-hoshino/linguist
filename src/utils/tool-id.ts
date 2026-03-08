// src/utils/tool-id.ts — 工具调用 ID 规范化

import { v5 as uuidv5 } from 'uuid';
import type { InternalMessage, InternalChatResponse, InternalChatStreamChunk } from '../types';

/**
 * 用于将工具 ID 确定性映射为 UUID 的固定命名空间（RFC4122 DNS 命名空间）。
 */
const TOOL_ID_NS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

/**
 * 将任意 tool call id 通过 UUID v5 映射为确定性 UUID。
 *
 * - 相同原始 id 永远生成相同 UUID（SHA-1 确定性哈希）。
 * - 不同原始 id 生成不同 UUID（UUID v5 碰撞概率可忽略不计）。
 * - 无需合法性判断，所有 id 一律转换，逻辑统一。
 */
function toUUID(id: string): string {
  return uuidv5(id.length > 0 ? id : 'tool_call', TOOL_ID_NS);
}

/**
 * 对 InternalMessage[] 中所有工具调用 / 响应的 ID 统一转换为 UUID v5。
 *
 * 处理规则：
 * 1. 构建原始 id → UUID 映射表（每个 id 只哈希一次）。
 * 2. 重写 assistant 消息的 `tool_calls[].id`。
 * 3. 重写 tool 消息的 `tool_call_id`（使用同一映射表，与步骤 2 严格一致）。
 *
 * 注意：此函数返回新数组和新消息对象（immutable），不修改原始数据。
 */
export function normalizeToolCallIds(messages: InternalMessage[]): InternalMessage[] {
  // 第一遍：收集所有涉及的 id，建立映射表
  const idMap = new Map<string, string>();

  const register = (rawId: string): void => {
    if (!idMap.has(rawId)) {
      idMap.set(rawId, toUUID(rawId));
    }
  };

  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        register(tc.id);
      }
    }
    if (msg.role === 'tool' && msg.tool_call_id !== undefined) {
      register(msg.tool_call_id);
    }
  }

  if (idMap.size === 0) {
    return messages;
  }

  // 第二遍：重写 id
  return messages.map((msg) => {
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      return {
        ...msg,
        tool_calls: msg.tool_calls.map((tc) => ({
          ...tc,
          id: idMap.get(tc.id) ?? tc.id,
        })),
      };
    }
    if (msg.role === 'tool' && msg.tool_call_id !== undefined) {
      const mapped = idMap.get(msg.tool_call_id);
      if (mapped !== undefined) {
        return { ...msg, tool_call_id: mapped };
      }
    }
    return msg;
  });
}

/**
 * 对提供商返回的非流式聊天响应中的 tool_calls[].id 进行 UUID v5 规范化。
 *
 * 原始 id（如 `call_68de4ba0a07645b187eeffc3`）统一映射为 UUID，
 * 确保响应侧 ID 与请求侧历史消息的规范化策略一致。
 */
export function normalizeResponseToolCallIds(response: InternalChatResponse): InternalChatResponse {
  const hasToolCalls = response.choices.some(
    (c) => c.message.tool_calls !== undefined && c.message.tool_calls.length > 0,
  );
  if (!hasToolCalls) {
    return response;
  }

  return {
    ...response,
    choices: response.choices.map((choice) => {
      if (!choice.message.tool_calls || choice.message.tool_calls.length === 0) {
        return choice;
      }
      return {
        ...choice,
        message: {
          ...choice.message,
          tool_calls: choice.message.tool_calls.map((tc) => ({
            ...tc,
            id: toUUID(tc.id),
          })),
        },
      };
    }),
  };
}

/**
 * 对提供商返回的流式 chunk 中的 tool_calls[].id 进行 UUID v5 规范化。
 *
 * 流式场景下 id 通常仅在第一个包含该工具调用的 chunk 中出现，
 * 仅对非 undefined 的 id 进行转换。
 */
export function normalizeStreamChunkToolCallIds(chunk: InternalChatStreamChunk): InternalChatStreamChunk {
  const hasToolCalls = chunk.choices.some((c) => c.delta.tool_calls !== undefined && c.delta.tool_calls.length > 0);
  if (!hasToolCalls) {
    return chunk;
  }

  return {
    ...chunk,
    choices: chunk.choices.map((choice) => {
      if (!choice.delta.tool_calls || choice.delta.tool_calls.length === 0) {
        return choice;
      }
      return {
        ...choice,
        delta: {
          ...choice.delta,
          tool_calls: choice.delta.tool_calls.map((tc) => ({
            ...tc,
            id: tc.id !== undefined ? toUUID(tc.id) : undefined,
          })),
        },
      };
    }),
  };
}
