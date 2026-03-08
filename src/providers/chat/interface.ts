// src/providers/chat/interface.ts — 提供商聊天适配器接口定义

import type {
  InternalChatRequest,
  InternalChatResponse,
  InternalChatStreamChunk,
  ProviderCallResult,
  ProviderStreamResult,
} from '../../types';

/**
 * 将内部请求转为厂商请求格式
 * routedModel 来自 GatewayContext.routedModel，因为 InternalChatRequest 不含 model 字段
 */
export interface ProviderChatRequestAdapter {
  toProviderRequest(internalReq: InternalChatRequest, routedModel: string): Record<string, unknown>;
}

/**
 * 将厂商响应转为内部响应格式（非流式）
 */
export interface ProviderChatResponseAdapter {
  fromProviderResponse(providerRes: unknown): InternalChatResponse;
}

/**
 * 将厂商流式响应单个 chunk 转为内部统一流式 chunk 格式
 */
export interface ProviderChatStreamResponseAdapter {
  fromProviderStreamChunk(providerChunk: unknown): InternalChatStreamChunk;
}

/**
 * 封装与厂商 API 的 HTTP 通信
 * @param providerReq 厂商格式的请求体
 * @param model 实际模型名称（部分厂商需要嵌入 URL 路径）
 */
export interface ProviderChatClient {
  /** 非流式调用：返回解析后的 JSON 响应 + 双向头部 */
  call(providerReq: Record<string, unknown>, model: string): Promise<ProviderCallResult>;
  /** 流式调用：返回原始 Response + 请求头（调用方从 body 读取 SSE 流） */
  callStream(providerReq: Record<string, unknown>, model: string): Promise<ProviderStreamResult>;
}
