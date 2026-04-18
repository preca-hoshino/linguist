// src/users/index.ts — 用户适配器注册中心

import { createCachedLoggerFactory, createLogger, GatewayError, logColors } from '@/utils';
import {
  AnthropicChatRequestAdapter,
  AnthropicChatResponseAdapter,
  AnthropicChatStreamResponseAdapter,
} from './anthropic';
import {
  GeminiChatRequestAdapter,
  GeminiChatResponseAdapter,
  GeminiChatStreamResponseAdapter,
  GeminiEmbeddingRequestAdapter,
  GeminiEmbeddingResponseAdapter,
} from './gemini';
import {
  OpenAICompatChatRequestAdapter,
  OpenAICompatChatResponseAdapter,
  OpenAICompatChatStreamResponseAdapter,
  OpenAICompatEmbeddingRequestAdapter,
  OpenAICompatEmbeddingResponseAdapter,
} from './openaicompat';
import type { UserChatAdapter, UserEmbeddingAdapter } from './types';

export * from './error-handler';
export type * from './types';

// ========== 动态 User Format Logger ==========

const getUserFormatLogger = createCachedLoggerFactory(
  {
    openaicompat: { label: 'User:OpenAICompat', color: logColors.bold + logColors.cyan },
    gemini: { label: 'User:Gemini', color: logColors.bold + logColors.blue },
    claude: { label: 'User:Anthropic', color: logColors.bold + logColors.magenta },
  },
  'User',
  logColors.bold + logColors.cyan,
);

const registryLogger = createLogger('Users', logColors.bold + logColors.cyan);

// ==================== 聊天适配器 ====================

const chatAdapters: Record<string, UserChatAdapter> = {};

/** 注册用户聊天适配器（启动时调用，将 userFormat 与其适配器绑定） */
export function registerChatAdapter(format: string, adapter: UserChatAdapter): void {
  chatAdapters[format] = adapter;
  registryLogger.info({ format }, 'Chat user adapter registered');
}

/**
 * 按 userFormat 获取聊天用户适配器
 *
 * 返回配对的请求/响应/流式响应适配器，未注册的格式抛出 GatewayError。
 */
export function getUserChatAdapter(format: string): UserChatAdapter {
  const adapter = chatAdapters[format];
  if (!adapter) {
    throw new GatewayError(400, 'unknown_format', `Unknown user chat format: ${format}`);
  }
  getUserFormatLogger(format).debug('Getting chat user adapter');
  return adapter;
}

// ==================== 嵌入适配器 ====================

const embeddingAdapters: Record<string, UserEmbeddingAdapter> = {};

/** 注册用户嵌入适配器（启动时调用，将 userFormat 与其适配器绑定） */
export function registerEmbeddingAdapter(format: string, adapter: UserEmbeddingAdapter): void {
  embeddingAdapters[format] = adapter;
  registryLogger.info({ format }, 'Embedding user adapter registered');
}

/**
 * 按 userFormat 获取嵌入用户适配器
 *
 * 返回配对的请求/响应适配器，未注册的格式抛出 GatewayError。
 */
export function getUserEmbeddingAdapter(format: string): UserEmbeddingAdapter {
  const adapter = embeddingAdapters[format];
  if (!adapter) {
    throw new GatewayError(400, 'unknown_format', `Unknown user embedding format: ${format}`);
  }
  getUserFormatLogger(format).debug('Getting embedding user adapter');
  return adapter;
}

// ==================== 注册内置适配器 ====================

registerChatAdapter('openaicompat', {
  request: new OpenAICompatChatRequestAdapter(),
  response: new OpenAICompatChatResponseAdapter(),
  streamResponse: new OpenAICompatChatStreamResponseAdapter(),
});

registerChatAdapter('gemini', {
  request: new GeminiChatRequestAdapter(),
  response: new GeminiChatResponseAdapter(),
  streamResponse: new GeminiChatStreamResponseAdapter(),
});

registerChatAdapter('anthropic', {
  request: new AnthropicChatRequestAdapter(),
  response: new AnthropicChatResponseAdapter(),
  streamResponse: new AnthropicChatStreamResponseAdapter(),
});

// ==================== 注册内置嵌入适配器 ====================

registerEmbeddingAdapter('openaicompat', {
  request: new OpenAICompatEmbeddingRequestAdapter(),
  response: new OpenAICompatEmbeddingResponseAdapter(),
});

registerEmbeddingAdapter('gemini', {
  request: new GeminiEmbeddingRequestAdapter(),
  response: new GeminiEmbeddingResponseAdapter(),
});
