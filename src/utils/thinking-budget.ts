// src/utils/thinking-budget.ts — 思考程度级别双向转换工具函数
//
// 提供 effort level name ↔ budget_tokens 的正向/反向映射，
// 以及 thinking_config 的运行时校验。

import type { ThinkingEffortLevel, ModelThinkingConfig } from '@/types';

import { GatewayError } from '@/utils/errors';

// ==================== 正向映射：effort level → budget_tokens ====================

/**
 * 将 effort level name 转换为 budget_tokens
 *
 * 查找 levels 中匹配 name 的级别，返回 Math.round(maxTokens × level.ratio)。
 * 找不到匹配时返回 undefined。
 */
export function effortToBudgetTokens(
  effort: string,
  maxTokens: number,
  levels: ThinkingEffortLevel[],
): number | undefined {
  const normalizedEffort = effort.toLowerCase();
  const level = levels.find((l) => l.name.toLowerCase() === normalizedEffort);
  if (level === undefined) {
    return undefined;
  }
  return Math.round(maxTokens * level.ratio);
}

// ==================== 反向映射：budget_tokens → effort level ====================

/**
 * 将 budget_tokens / max_tokens 比率反向映射为最接近的 effort level name
 *
 * 从高到低扫描 levels，找到 ratio ≤ 实际比率的最高级别。
 * 若比率低于最低级别阈值，返回 undefined（不传 reasoning_effort）。
 */
export function budgetToEffort(
  budgetTokens: number,
  maxTokens: number,
  levels: ThinkingEffortLevel[],
): string | undefined {
  if (maxTokens <= 0 || levels.length === 0) {
    return undefined;
  }
  const ratio = budgetTokens / maxTokens;
  // levels 已按 ratio 升序排列，从高到低扫描
  for (let i = levels.length - 1; i >= 0; i--) {
    const level = levels[i];
    if (level !== undefined && ratio >= level.ratio) {
      return level.name;
    }
  }
  return undefined;
}

// ==================== 工具函数 ====================

/**
 * 获取所有 effort level 名称列表
 */
export function getEffortLevelNames(levels: ThinkingEffortLevel[]): string[] {
  return levels.map((l) => l.name);
}

// ==================== 校验 ====================

/**
 * 校验 thinking_config 配置
 *
 * 校验规则：
 * - 必须是对象
 * - enabled 必须是 boolean
 * - reasoning_content_backfill 可选，boolean
 * - levels 可选，但若提供则：
 *   - 数组非空
 *   - 每个 level 的 name 为非空字符串
 *   - 每个 level 的 ratio 在 (0, 1] 范围
 *   - name 不重复
 *   - 按 ratio 升序排列
 */
export function validateModelThinkingConfig(config: unknown): ModelThinkingConfig {
  if (config === null || config === undefined || typeof config !== 'object') {
    throw new GatewayError(400, 'invalid_parameter', 'thinking_config must be an object');
  }
  const obj = config as Record<string, unknown>;

  // enabled
  if (typeof obj.enabled !== 'boolean') {
    throw new GatewayError(400, 'invalid_parameter', 'thinking_config.enabled must be a boolean');
  }

  // reasoning_content_backfill（可选）
  if (obj.reasoning_content_backfill !== undefined && typeof obj.reasoning_content_backfill !== 'boolean') {
    throw new GatewayError(
      400,
      'invalid_parameter',
      'thinking_config.reasoning_content_backfill must be a boolean',
    );
  }

  // levels（可选）
  const result: ModelThinkingConfig = {
    enabled: obj.enabled as boolean,
    reasoning_content_backfill: obj.reasoning_content_backfill as boolean | undefined,
  };

  if (obj.levels !== undefined && obj.levels !== null) {
    if (!Array.isArray(obj.levels)) {
      throw new GatewayError(400, 'invalid_parameter', 'thinking_config.levels must be an array');
    }
    const levels = obj.levels as unknown[];
    if (levels.length === 0) {
      throw new GatewayError(400, 'invalid_parameter', 'thinking_config.levels must not be empty');
    }

    const seen = new Set<string>();
    let prevRatio = 0;
    const validated: ThinkingEffortLevel[] = [];

    for (const [i, item] of levels.entries()) {
      if (item === null || typeof item !== 'object') {
        throw new GatewayError(
          400,
          'invalid_parameter',
          `thinking_config.levels[${String(i)}] must be an object`,
        );
      }
      const level = item as Record<string, unknown>;

      if (typeof level.name !== 'string' || level.name.length === 0) {
        throw new GatewayError(
          400,
          'invalid_parameter',
          `thinking_config.levels[${String(i)}].name must be a non-empty string`,
        );
      }
      if (typeof level.ratio !== 'number' || level.ratio <= 0 || level.ratio > 1) {
        throw new GatewayError(
          400,
          'invalid_parameter',
          `thinking_config.levels[${String(i)}].ratio must be a number in (0, 1]`,
        );
      }

      const normalizedName = (level.name as string).toLowerCase();
      if (seen.has(normalizedName)) {
        throw new GatewayError(
          400,
          'invalid_parameter',
          `thinking_config.levels[${String(i)}].name "${String(level.name)}" is duplicated`,
        );
      }
      seen.add(normalizedName);

      if (level.ratio < prevRatio) {
        throw new GatewayError(
          400,
          'invalid_parameter',
          `thinking_config.levels must be sorted by ratio in ascending order`,
        );
      }
      prevRatio = level.ratio;

      validated.push({ name: level.name as string, ratio: level.ratio as number });
    }

    result.levels = validated;
  }

  return result;
}
