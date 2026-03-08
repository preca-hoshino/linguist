// src/users/chat/interface.ts — 聊天用户适配器接口定义

import type { InternalChatRequest, InternalChatStreamChunk } from '../../types';
import type { GatewayContext } from '../../types';

/**
 * 用户聊天请求适配器
 * 将用户格式的请求体转为内部统一格式（不含 model 字段）
 */
export interface UserChatRequestAdapter {
  toInternal(userReq: unknown): InternalChatRequest;
}

/**
 * 用户聊天响应适配器（非流式）
 * 从 GatewayContext 中取 response、id、requestModel 等组装用户格式响应
 */
export interface UserChatResponseAdapter {
  fromInternal(ctx: GatewayContext): Record<string, unknown>;
}

/**
 * 用户聊天流式响应适配器
 * 将 InternalChatStreamChunk 转为用户格式的 SSE 数据行
 */
export interface UserChatStreamResponseAdapter {
  /** 将单个内部 chunk 转为用户格式的 SSE 行（含 "data: " 前缀 + "\n\n" 后缀） */
  formatChunk(ctx: GatewayContext, chunk: InternalChatStreamChunk): string;
  /** 返回流结束标记（如 OpenAI 的 "data: [DONE]\n\n"），无标记时返回 null */
  formatEnd(): string | null;
}

/**
 * 组合接口，核心流程通过此接口获取配对的请求/响应适配器
 */
export interface UserChatAdapter {
  request: UserChatRequestAdapter;
  response: UserChatResponseAdapter;
  streamResponse: UserChatStreamResponseAdapter;
}
