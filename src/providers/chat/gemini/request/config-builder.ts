// src/providers/chat/gemini/request/config-builder.ts — Gemini 配置构建

import type { InternalChatRequest } from '../../../../types';
import type { GeminiGenerationConfig, GeminiThinkingConfig } from './types';

// ==================== generationConfig ====================

/**
 * 从 InternalChatRequest 构建 Gemini generationConfig
 */
export function buildGenerationConfig(req: InternalChatRequest): GeminiGenerationConfig {
  const config: GeminiGenerationConfig = {};

  if (req.max_tokens !== undefined) {
    config.maxOutputTokens = req.max_tokens;
  }
  if (req.temperature !== undefined) {
    config.temperature = req.temperature;
  }
  if (req.top_p !== undefined) {
    config.topP = req.top_p;
  }
  if (req.top_k !== undefined) {
    config.topK = req.top_k;
  }
  if (req.stop !== undefined) {
    config.stopSequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  }

  // response_format → Gemini responseMimeType / responseSchema
  if (req.response_format) {
    if (req.response_format.type === 'json_object') {
      config.responseMimeType = 'application/json';
    } else if (req.response_format.type === 'json_schema') {
      config.responseMimeType = 'application/json';
      config.responseSchema = req.response_format.json_schema.schema;
    }
    // type='text' 不需要显式设置（Gemini 默认）
  }

  return config;
}

// ==================== thinkingConfig ====================

/**
 * 构建 Gemini thinkingConfig
 */
export function buildThinkingConfig(thinking: NonNullable<InternalChatRequest['thinking']>): GeminiThinkingConfig {
  const config: GeminiThinkingConfig = {
    // type !== 'disabled' 即启用思考（enabled 或 auto 均输出思维链）
    includeThoughts: thinking.type !== 'disabled',
  };
  if (thinking.budget_tokens !== undefined) {
    config.thinkingBudget = thinking.budget_tokens;
  }
  return config;
}
