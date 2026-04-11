// src/users/gemini/chat/request/thinking-converter.ts — Gemini 思考配置转换

import type { InternalChatRequest } from '@/types';
import type { GeminiThinkingConfig, GeminiThinkingLevel } from './types';

// ==================== thinkingLevel → 百分比映射 ====================

/** thinkingLevel 对应 maxOutputTokens 的百分比 */
const THINKING_LEVEL_RATIO: Record<GeminiThinkingLevel, number> = {
  MINIMAL: 0.05,
  LOW: 0.2,
  MEDIUM: 0.5,
  HIGH: 0.8,
};

// ==================== thinkingConfig 转换 ====================

/**
 * Gemini thinkingConfig → InternalChatRequest.thinking
 *
 * 优先级：thinkingBudget（直接数值） > thinkingLevel（按 maxOutputTokens 百分比计算）
 * thinkingLevel 按 maxOutputTokens 的百分比换算为 budget_tokens：
 * - MINIMAL → 5%, LOW → 20%, MEDIUM → 50%, HIGH → 80%
 * - maxOutputTokens 未指定时不设置 budget_tokens（交由提供商使用默认值）
 */
export function convertThinkingConfig(
  config?: GeminiThinkingConfig,
  maxOutputTokens?: number,
): InternalChatRequest['thinking'] {
  if (!config) {
    return;
  }

  // thinkingBudget 直接使用，否则从 thinkingLevel 按百分比计算
  const budgetTokens = config.thinkingBudget ?? resolveThinkingLevel(config.thinkingLevel, maxOutputTokens);

  // includeThoughts=false → disabled，否则 enabled（Gemini 无 auto 概念）
  const type = config.includeThoughts === false ? 'disabled' : 'enabled';

  return {
    type,
    budget_tokens: budgetTokens,
  };
}

/** 将 thinkingLevel 按 maxOutputTokens 百分比转为 budget_tokens */
function resolveThinkingLevel(level?: string, maxOutputTokens?: number): number | undefined {
  if (level === undefined || level === '') {
    return;
  }
  const upper = level.toUpperCase();
  if (!(upper in THINKING_LEVEL_RATIO)) {
    return;
  }
  if (maxOutputTokens === undefined) {
    return;
  }
  return Math.round(maxOutputTokens * THINKING_LEVEL_RATIO[upper as GeminiThinkingLevel]);
}
