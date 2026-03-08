// src/users/embedding/interface.ts — 嵌入用户适配器接口定义

import type { InternalEmbeddingRequest } from '../../types';
import type { GatewayContext } from '../../types';

/**
 * 用户嵌入请求适配器
 * 将用户格式的请求体转为内部统一格式（不含 model 字段）
 */
export interface UserEmbeddingRequestAdapter {
  toInternal(userReq: unknown): InternalEmbeddingRequest;
}

/**
 * 用户嵌入响应适配器
 * 从 GatewayContext 组装最终嵌入响应
 */
export interface UserEmbeddingResponseAdapter {
  fromInternal(ctx: GatewayContext): Record<string, unknown>;
}

/**
 * 组合接口
 */
export interface UserEmbeddingAdapter {
  request: UserEmbeddingRequestAdapter;
  response: UserEmbeddingResponseAdapter;
}
