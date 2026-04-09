// src/providers/index.ts — 提供商注册中心与统一暴露点

import type { ProviderConfig } from '@/types';
import { createLogger, GatewayError, logColors } from '@/utils';
// 后续将在下一步重组的各厂商插件
import { copilotPlugin } from './copilot';
import { deepseekPlugin } from './deepseek';
import { geminiPlugin } from './gemini';
import type { ProviderChatAdapterSet, ProviderEmbeddingAdapterSet, ProviderPlugin } from './types';
import { volcenginePlugin } from './volcengine';

const logger = createLogger('Providers', logColors.bold + logColors.green);

const registry = new Map<string, ProviderPlugin>();

/**
 * 注册提供商插件
 */
export function registerPlugin(plugin: ProviderPlugin): void {
  if (plugin.kind === '') {
    logger.error({ plugin }, 'Invalid plugin object provided for registration: kind is empty');
    return;
  }
  registry.set(plugin.kind, plugin);
  logger.info({ provider: plugin.kind }, 'Provider plugin registered');
}

// 注册内置提供商插件
registerPlugin(deepseekPlugin);
registerPlugin(geminiPlugin);
registerPlugin(volcenginePlugin);
registerPlugin(copilotPlugin);

/**
 * 获取注册的插件对象
 */
export function getProviderPlugin(providerKind: string): ProviderPlugin {
  const plugin = registry.get(providerKind);
  if (!plugin) {
    throw new GatewayError(400, 'unknown_provider', `Unknown provider: ${providerKind}`);
  }
  return plugin;
}

/**
 * 获取已注册的全部厂商标志
 */
export function getRegisteredProviderKinds(): Set<string> {
  return new Set(registry.keys());
}

/**
 * 按提供商 kind 获取聊天适配器集合 (提供给 engine 使用)
 */
export function getProviderChatAdapterSet(providerKind: string, config: ProviderConfig): ProviderChatAdapterSet {
  const plugin = getProviderPlugin(providerKind);
  if (!plugin.getChatAdapterSet) {
    throw new GatewayError(400, 'unsupported_feature', `Provider ${providerKind} does not support chat`);
  }
  return plugin.getChatAdapterSet(config);
}

/**
 * 按提供商 kind 获取嵌入适配器集合 (提供给 engine 使用)
 */
export function getProviderEmbeddingAdapterSet(
  providerKind: string,
  config: ProviderConfig,
): ProviderEmbeddingAdapterSet {
  const plugin = getProviderPlugin(providerKind);
  if (!plugin.getEmbeddingAdapterSet) {
    throw new GatewayError(400, 'unsupported_feature', `Provider ${providerKind} does not support embedding`);
  }
  return plugin.getEmbeddingAdapterSet(config);
}

export * from './engine';
export * from './errors';
export type * from './types';
