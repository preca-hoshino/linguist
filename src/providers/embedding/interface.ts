// src/providers/embedding/interface.ts — 提供商嵌入适配器接口定义

import type { InternalEmbeddingRequest, InternalEmbeddingResponse, ProviderCallResult } from '../../types';

/**
 * 将内部嵌入请求转为厂商请求格式
 */
export interface ProviderEmbeddingRequestAdapter {
  toProviderRequest(internalReq: InternalEmbeddingRequest, routedModel: string): Record<string, unknown>;
}

/**
 * 将厂商嵌入响应转为内部响应格式
 */
export interface ProviderEmbeddingResponseAdapter {
  fromProviderResponse(providerRes: unknown): InternalEmbeddingResponse;
}

/**
 * 封装与厂商嵌入 API 的 HTTP 通信
 * @param providerReq 厂商格式的请求体
 * @param model 实际模型名称
 */
export interface ProviderEmbeddingClient {
  call(providerReq: Record<string, unknown>, model: string): Promise<ProviderCallResult>;
}
