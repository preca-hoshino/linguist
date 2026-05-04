// src/model/http/users/gemini/chat/request/tool-call-cleaner.ts — 孤立 tool_calls 清理

import type { InternalMessage } from '@/types';
import { createLogger, logColors } from '@/utils';

const logger = createLogger('User:Gemini', logColors.bold + logColors.blue);

/**
 * 移除没有对应 tool 响应消息的 tool_calls，以及没有对应 tool_call 的 tool 消息。
 *
 * Gemini 内置工具（如 builtin_web_search）由 Gemini 内部处理，
 * 对话历史中可能只包含 functionCall 而没有显式 functionResponse，
 * 转换为 OpenAI 格式后会导致下游提供商（如 DeepSeek）报错。
 */
export function removeOrphanedToolCalls(messages: InternalMessage[]): InternalMessage[] {
  // 收集所有 tool 消息的 tool_call_id
  const respondedIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.tool_call_id !== undefined && msg.tool_call_id !== '') {
      respondedIds.add(msg.tool_call_id);
    }
  }

  // 收集所有 assistant 消息中的 tool_call id
  const calledIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        calledIds.add(tc.id);
      }
    }
  }

  const result: InternalMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      // 过滤掉没有对应 tool 响应的 tool_calls
      const filtered = msg.tool_calls.filter((tc) => respondedIds.has(tc.id));
      if (filtered.length === 0) {
        // 全部 tool_calls 都是孤立的，移除 tool_calls 字段
        const { tool_calls: _removed, ...rest } = msg;
        // 仅在消息仍有内容时保留
        if (rest.content !== '') {
          result.push(rest as InternalMessage);
        }
      } else {
        result.push({ ...msg, tool_calls: filtered });
      }
    } else if (msg.role === 'tool') {
      // 过滤掉没有对应 assistant tool_call 的 tool 消息
      if (msg.tool_call_id !== undefined && msg.tool_call_id !== '' && calledIds.has(msg.tool_call_id)) {
        result.push(msg);
      } else {
        logger.debug(
          { toolCallId: msg.tool_call_id, name: msg.name },
          'Removing orphaned tool response message (no matching tool_call)',
        );
      }
    } else {
      result.push(msg);
    }
  }

  return result;
}
