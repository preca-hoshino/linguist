// src/providers/index.ts — 提供商注册中心

import type {
  ProviderChatRequestAdapter,
  ProviderChatResponseAdapter,
  ProviderChatClient,
  ProviderChatStreamResponseAdapter,
} from './chat';
import type {
  ProviderEmbeddingRequestAdapter,
  ProviderEmbeddingResponseAdapter,
  ProviderEmbeddingClient,
} from './embedding';
import type { ProviderConfig } from '../types';
import {
  DeepSeekChatRequestAdapter,
  DeepSeekChatResponseAdapter,
  DeepSeekChatStreamResponseAdapter,
  DeepSeekChatClient,
} from './chat/deepseek';
import {
  GeminiChatRequestAdapter,
  GeminiChatResponseAdapter,
  GeminiChatStreamResponseAdapter,
  GeminiChatClient,
} from './chat/gemini';
import {
  VolcEngineChatRequestAdapter,
  VolcEngineChatResponseAdapter,
  VolcEngineChatStreamResponseAdapter,
  VolcEngineChatClient,
} from './chat/volcengine';
import {
  VolcEngineEmbeddingRequestAdapter,
  VolcEngineEmbeddingResponseAdapter,
  VolcEngineEmbeddingClient,
} from './embedding/volcengine';
import {
  GeminiEmbeddingRequestAdapter,
  GeminiEmbeddingResponseAdapter,
  GeminiEmbeddingClient,
} from './embedding/gemini';
import { GatewayError, createLogger, logColors } from '../utils';

const logger = createLogger('Providers', logColors.bold + logColors.green);

// ==================== 聊天提供商 ====================

/**
 * 聊天提供商适配器集合
 *
 * 将请求适配器、响应适配器（非流式 + 流式）和 HTTP 客户端打包为一组，
 * 由 caller 统一调用。每个提供商（DeepSeek / Gemini / 火山引擎）各注册一套。
 */
export interface ProviderChatAdapterSet {
  requestAdapter: ProviderChatRequestAdapter;
  responseAdapter: ProviderChatResponseAdapter;
  streamResponseAdapter: ProviderChatStreamResponseAdapter;
  client: ProviderChatClient;
}

type ChatAdapterFactory = (config: ProviderConfig) => ProviderChatAdapterSet;

const chatFactories: Record<string, ChatAdapterFactory> = {};

/**
 * 注册聊天提供商适配器工厂
 *
 * 启动时调用，将提供商 kind 与其适配器工厂绑定。
 * 注册后自动清除 registeredKindsCache，供 admin 校验使用。
 */
export function registerChatProvider(name: string, factory: ChatAdapterFactory): void {
  chatFactories[name] = factory;
  registeredKindsCache = null;
  logger.info({ provider: name }, 'Chat provider registered');
}

/**
 * 按提供商 kind 获取聊天适配器集合
 *
 * 调用已注册的工厂函数创建适配器实例（client 依赖 config 中的 apiKey/baseUrl）。
 * 未注册的 kind 抛出 GatewayError。
 */
export function getProviderChatAdapterSet(providerName: string, config: ProviderConfig): ProviderChatAdapterSet {
  const factory = chatFactories[providerName];
  if (!factory) {
    throw new GatewayError(400, 'unknown_provider', `Unknown chat provider: ${providerName}`);
  }
  logger.debug({ providerName, providerId: config.id }, 'Creating chat adapter set');
  return factory(config);
}

/** 已注册的提供商 kind 集合缓存 */
let registeredKindsCache: Set<string> | null = null;

/** 获取所有已注册的提供商 kind 集合（结果缓存，注册后自动失效） */
export function getRegisteredProviderKinds(): Set<string> {
  if (registeredKindsCache) {
    return registeredKindsCache;
  }
  const kinds = new Set<string>();
  for (const k of Object.keys(chatFactories)) {
    kinds.add(k);
  }
  for (const k of Object.keys(embeddingFactories)) {
    kinds.add(k);
  }
  registeredKindsCache = kinds;
  return kinds;
}

// ==================== 嵌入提供商 ====================

/**
 * 嵌入提供商适配器集合
 *
 * 与聊天类似，将嵌入的请求适配器、响应适配器和 HTTP 客户端打包为一组。
 * 嵌入不支持流式，因此无 streamResponseAdapter。
 */
export interface ProviderEmbeddingAdapterSet {
  requestAdapter: ProviderEmbeddingRequestAdapter;
  responseAdapter: ProviderEmbeddingResponseAdapter;
  client: ProviderEmbeddingClient;
}

type EmbeddingAdapterFactory = (config: ProviderConfig) => ProviderEmbeddingAdapterSet;

const embeddingFactories: Record<string, EmbeddingAdapterFactory> = {};

/** 注册嵌入提供商适配器工厂 */
export function registerEmbeddingProvider(name: string, factory: EmbeddingAdapterFactory): void {
  embeddingFactories[name] = factory;
  registeredKindsCache = null;
  logger.info({ provider: name }, 'Embedding provider registered');
}

/**
 * 按提供商 kind 获取嵌入适配器集合
 *
 * 未注册的 kind 抛出 GatewayError。
 */
export function getProviderEmbeddingAdapterSet(
  providerName: string,
  config: ProviderConfig,
): ProviderEmbeddingAdapterSet {
  const factory = embeddingFactories[providerName];
  if (!factory) {
    throw new GatewayError(400, 'unknown_provider', `Unknown embedding provider: ${providerName}`);
  }
  logger.debug({ providerName, providerId: config.id }, 'Creating embedding adapter set');
  return factory(config);
}

// ==================== 注册内置提供商 ====================

// 无状态适配器单例（避免每次请求都创建新实例）
const deepseekRequestAdapter = new DeepSeekChatRequestAdapter();
const deepseekResponseAdapter = new DeepSeekChatResponseAdapter();
const deepseekStreamResponseAdapter = new DeepSeekChatStreamResponseAdapter();
const geminiChatRequestAdapter = new GeminiChatRequestAdapter();
const geminiChatResponseAdapter = new GeminiChatResponseAdapter();
const geminiChatStreamResponseAdapter = new GeminiChatStreamResponseAdapter();
const volcengineChatRequestAdapter = new VolcEngineChatRequestAdapter();
const volcengineChatResponseAdapter = new VolcEngineChatResponseAdapter();
const volcengineChatStreamResponseAdapter = new VolcEngineChatStreamResponseAdapter();

registerChatProvider('deepseek', (config) => ({
  requestAdapter: deepseekRequestAdapter,
  responseAdapter: deepseekResponseAdapter,
  streamResponseAdapter: deepseekStreamResponseAdapter,
  client: new DeepSeekChatClient(config.apiKey, config.baseUrl),
}));

registerChatProvider('gemini', (config) => ({
  requestAdapter: geminiChatRequestAdapter,
  responseAdapter: geminiChatResponseAdapter,
  streamResponseAdapter: geminiChatStreamResponseAdapter,
  client: new GeminiChatClient(config.apiKey, config.baseUrl),
}));

registerChatProvider('volcengine', (config) => ({
  requestAdapter: volcengineChatRequestAdapter,
  responseAdapter: volcengineChatResponseAdapter,
  streamResponseAdapter: volcengineChatStreamResponseAdapter,
  client: new VolcEngineChatClient(config.apiKey, config.baseUrl),
}));

// ==================== 注册内置嵌入提供商 ====================

const volcengineEmbeddingRequestAdapter = new VolcEngineEmbeddingRequestAdapter();
const volcengineEmbeddingResponseAdapter = new VolcEngineEmbeddingResponseAdapter();
const geminiEmbeddingRequestAdapter = new GeminiEmbeddingRequestAdapter();
const geminiEmbeddingResponseAdapter = new GeminiEmbeddingResponseAdapter();

registerEmbeddingProvider('volcengine', (config) => ({
  requestAdapter: volcengineEmbeddingRequestAdapter,
  responseAdapter: volcengineEmbeddingResponseAdapter,
  client: new VolcEngineEmbeddingClient(config.apiKey, config.baseUrl),
}));

registerEmbeddingProvider('gemini', (config) => ({
  requestAdapter: geminiEmbeddingRequestAdapter,
  responseAdapter: geminiEmbeddingResponseAdapter,
  client: new GeminiEmbeddingClient(config.apiKey, config.baseUrl),
}));
