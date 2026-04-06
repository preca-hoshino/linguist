// src/middleware/response/normalize-tool-calls.ts — 工具调用 ID 规范化（响应侧）

import type { Middleware } from '@/middleware/types';
import { normalizeResponseToolCallIds } from '@/utils';

/**
 * 响应工具调用 ID 规范化中间件
 *
 * 将提供商返回的非流式 Chat 响应中的工具调用 ID 统一映射为 UUID v5，
 * 确保响应侧 ID 与请求侧历史消息的规范化策略完全一致。
 *
 * 仅对含 `choices` 字段的响应（即 InternalChatResponse）生效；
 * Embedding 响应及流式路径（每个 chunk 已在传输时单独规范化）直接跳过。
 */
export const normalizeResponseChatToolCallIds: Middleware = (ctx) => {
  if (ctx.response !== undefined && 'choices' in ctx.response) {
    ctx.response = normalizeResponseToolCallIds(ctx.response);
  }
};
