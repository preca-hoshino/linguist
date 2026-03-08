// src/users/index.ts — 用户适配器注册中心

import type { UserChatAdapter } from './chat';
import type { UserEmbeddingAdapter } from './embedding';
import {
  OpenAICompatChatRequestAdapter,
  OpenAICompatChatResponseAdapter,
  OpenAICompatChatStreamResponseAdapter,
} from './chat/openaicompat';
import { GeminiChatRequestAdapter, GeminiChatResponseAdapter, GeminiChatStreamResponseAdapter } from './chat/gemini';
import { OpenAICompatEmbeddingRequestAdapter, OpenAICompatEmbeddingResponseAdapter } from './embedding/openaicompat';
import { GeminiEmbeddingRequestAdapter, GeminiEmbeddingResponseAdapter } from './embedding/gemini';
import { GatewayError, createLogger, logColors } from '../utils';
import type { Logger } from '../utils';

// ========== 动态 User Format Logger ==========

const USER_FORMAT_LOG_SPEC: Record<string, { label: string; color: string }> = {
  openaicompat: { label: 'User:OpenAICompat', color: logColors.bold + logColors.cyan },
  gemini: { label: 'User:Gemini', color: logColors.bold + logColors.blue },
};

const userFormatLoggerCache: Record<string, Logger> = {};

function getUserFormatLogger(format: string): Logger {
  if (userFormatLoggerCache[format] === undefined) {
    const spec = USER_FORMAT_LOG_SPEC[format];
    const label = spec !== undefined ? spec.label : `User:${format}`;
    const color = spec !== undefined ? spec.color : logColors.bold + logColors.cyan;
    userFormatLoggerCache[format] = createLogger(label, color);
  }
  return userFormatLoggerCache[format];
}

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

// ==================== 注册内置嵌入适配器 ====================

registerEmbeddingAdapter('openaicompat', {
  request: new OpenAICompatEmbeddingRequestAdapter(),
  response: new OpenAICompatEmbeddingResponseAdapter(),
});

registerEmbeddingAdapter('gemini', {
  request: new GeminiEmbeddingRequestAdapter(),
  response: new GeminiEmbeddingResponseAdapter(),
});
