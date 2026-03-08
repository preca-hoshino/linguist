// src/middleware/request/normalize-tool-calls.ts — 工具调用 ID 规范化（请求侧）

import type { Middleware } from '../types';
import { normalizeToolCallIds } from '../../utils';

/**
 * 请求工具调用 ID 规范化中间件
 *
 * 将 Chat 请求消息中所有工具调用 / 工具响应的 ID 统一映射为 UUID v5。
 * 处理不合法或非标准 ID（含 `.`/`:` 等字符、过长、以函数名代替等）。
 *
 * 仅对 Chat 请求生效（通过检测 `ctx.request` 是否含 `messages` 字段）；
 * Embedding 请求无工具调用，直接跳过。
 */
export const normalizeChatToolCallIds: Middleware = (ctx) => {
  if (ctx.request !== undefined && 'messages' in ctx.request) {
    ctx.request.messages = normalizeToolCallIds(ctx.request.messages);
  }
};
