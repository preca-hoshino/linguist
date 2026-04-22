// src/providers/types.ts — 提供商插件化架构接口与类型定义

import type {
  InternalChatRequest,
  InternalChatResponse,
  InternalChatStreamChunk,
  InternalEmbeddingRequest,
  InternalEmbeddingResponse,
  ModelType,
  ProviderCallResult,
  ProviderConfig,
  ProviderStreamResult,
} from '@/types';

// ============================================================================
// 1. 聊天功能模块接口 (Chat Module)
// ============================================================================

export interface ProviderChatRequestAdapter {
  toProviderRequest: (internalReq: InternalChatRequest, routedModel: string) => Record<string, unknown>;
}

export interface ProviderChatResponseAdapter {
  fromProviderResponse: (providerRes: unknown) => InternalChatResponse;
}

export interface ProviderChatStreamResponseAdapter {
  fromProviderStreamChunk: (providerChunk: unknown) => InternalChatStreamChunk;
}

/** 提供商调用可选选项 */
export interface ProviderCallOptions {
  /** API 调用超时时间（毫秒）。不传则使用 DEFAULT_PROVIDER_TIMEOUT 常量 */
  timeoutMs?: number | undefined;
  /** 模型请求级别的自定义请求头覆盖 */
  headers?: Record<string, string | null> | undefined;
}

export interface ProviderChatClient {
  call: (
    providerReq: Record<string, unknown>,
    model: string,
    options?: ProviderCallOptions,
  ) => Promise<ProviderCallResult>;
  callStream: (
    providerReq: Record<string, unknown>,
    model: string,
    options?: ProviderCallOptions,
  ) => Promise<ProviderStreamResult>;
}

export interface ProviderChatAdapterSet {
  requestAdapter: ProviderChatRequestAdapter;
  responseAdapter: ProviderChatResponseAdapter;
  streamResponseAdapter: ProviderChatStreamResponseAdapter;
  client: ProviderChatClient;
}

// ============================================================================
// 2. 嵌入功能模块接口 (Embedding Module)
// ============================================================================

export interface ProviderEmbeddingRequestAdapter {
  toProviderRequest: (internalReq: InternalEmbeddingRequest, routedModel: string) => Record<string, unknown>;
}

export interface ProviderEmbeddingResponseAdapter {
  fromProviderResponse: (providerRes: unknown) => InternalEmbeddingResponse;
}

export interface ProviderEmbeddingClient {
  call: (
    providerReq: Record<string, unknown>,
    model: string,
    options?: ProviderCallOptions,
  ) => Promise<ProviderCallResult>;
}

export interface ProviderEmbeddingAdapterSet {
  requestAdapter: ProviderEmbeddingRequestAdapter;
  responseAdapter: ProviderEmbeddingResponseAdapter;
  client: ProviderEmbeddingClient;
}

// ============================================================================
// 3. 通用错误处理模块接口 (Error Module)
// ============================================================================

export interface ProviderErrorInfo {
  gatewayStatusCode: number;
  gatewayErrorCode: string;
  providerErrorCode?: string | undefined;
  message: string;
}

// ============================================================================
// 4. 标准提供商插件接口 (Provider Plugin Architecture)
// ============================================================================

/**
 * 所有提供商必须实现此 Plugin 接口以注册到系统中。
 * 厂商的功能完全在内部闭环，统一暴露这个接口对象。
 */
export interface ProviderPlugin {
  /** 厂商标识符，如 'deepseek', 'gemini' */
  kind: string;

  /**
   * 该厂商所支持的模型类型列表（由代码实现决定，不可运行时修改）。
   * 前端可据此过滤模型类别选型，防止配置错误的模型类型。
   */
  supportedModelTypes: ModelType[];

  /** 获取聊天功能集合 (如果该厂商支持聊天) */
  getChatAdapterSet?: (config: ProviderConfig) => ProviderChatAdapterSet;

  /** 获取嵌入功能集合 (如果该厂商支持嵌入) */
  getEmbeddingAdapterSet?: (config: ProviderConfig) => ProviderEmbeddingAdapterSet;

  /**
   * 厂商专属的错误映射处理函数。
   * @param status 提供商返回的 HTTP 状态码
   * @param body 提供商返回的原始响应体（文本）
   */
  mapError: (status: number, body: string) => ProviderErrorInfo;
}
