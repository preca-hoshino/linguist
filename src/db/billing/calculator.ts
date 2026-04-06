// src/db/billing/calculator.ts — 后置计费纯函数
//
// 企业级网关核心计费引擎：在收到上游响应后，根据 usage 和阶梯配置计算费用。
// 设计为无副作用纯函数（不碰 DB），方便 Jest 覆盖测试。

import type { BillingResult, PricingTier } from '@/types';

/**
 * 后置费用计算引擎
 *
 * 根据上游返回的实际 usage 和模型配置的阶梯价格，计算本次请求的准确费用。
 *
 * @param tiers        - 该模型配置的阶梯价格列表（无需排序，内部会按 startTokens 排序）
 * @param promptTokens - 上游返回的 usage.prompt_tokens（含缓存部分的总量）
 * @param completionTokens - 上游返回的 usage.completion_tokens
 * @param cachedTokens - 上游返回的缓存命中 Token 数（默认 0）
 */
export function calculatePostBillingCost(
  tiers: readonly PricingTier[],
  promptTokens: number,
  completionTokens: number,
  cachedTokens = 0,
): BillingResult {
  // 未配置阶梯 → 跳过（不计费）
  if (tiers.length === 0) {
    return { status: 'skipped', reason: 'no_tiers' };
  }

  // 无有效用量 → 跳过
  if (promptTokens <= 0 && completionTokens <= 0) {
    return { status: 'skipped', reason: 'no_usage' };
  }

  // 按 startTokens 降序排列后匹配第一个 ≤ promptTokens 的阶梯
  const sorted = [...tiers].toSorted((a, b) => b.startTokens - a.startTokens);
  const matchedTier = sorted.find((t) => promptTokens >= t.startTokens);

  // 兜底：如果所有阶梯都无法匹配（理论上不会发生，因为 startTokens=0 的阶梯会兜底）
  // 使用排序后的最后一个（即 startTokens 最小的）
  const tier = matchedTier ?? sorted.at(-1);
  if (!tier) {
    return { status: 'skipped', reason: 'no_tiers' };
  }

  // 拆分纯新输入 vs 缓存命中
  const safeCached = Math.max(0, Math.min(cachedTokens, promptTokens));
  const pureInputTokens = Math.max(0, promptTokens - safeCached);

  // 按百万 Token 换算（价格单位：每百万 Token，货币 CNY）
  const UNIT = 1_000_000;
  const inputCost = (pureInputTokens / UNIT) * tier.inputPrice;
  const cacheCost = (safeCached / UNIT) * tier.cachePrice;
  const outputCost = (completionTokens / UNIT) * tier.outputPrice;

  const totalCost = inputCost + cacheCost + outputCost;

  return {
    status: 'success',
    cost: toFixed6(totalCost),
    breakdown: {
      tierStartTokens: tier.startTokens,
      inputCost: toFixed6(inputCost),
      cacheCost: toFixed6(cacheCost),
      outputCost: toFixed6(outputCost),
    },
  };
}

/**
 * 精度安全的四舍五入到 6 位小数
 * 使用乘除法避免 JS 浮点数直接 toFixed 的舍入错误
 */
function toFixed6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
