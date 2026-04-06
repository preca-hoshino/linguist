// src/db/billing/lookup.ts — 阶梯价格查询
//
// 从 provider_models 表查询指定模型的阶梯价格配置。
// 在后置计费流程中，markCompleted 调用此函数获取当前模型的 pricing_tiers。

import { db } from '@/db/client';
import type { PricingTier } from '@/types';
import { createLogger, logColors } from '@/utils';

const logger = createLogger('Billing', logColors.bold + logColors.green);

/**
 * 根据路由解析后的 provider_id + 实际模型名查询阶梯价格配置
 *
 * 查询路径：provider_models WHERE provider_id = ? AND name = ?
 * 返回的 pricing_tiers 是预排序的（写入时已由 Admin API 校验）。
 *
 * @param providerId - 提供商 ID
 * @param modelName  - 提供商侧模型名（如 "gpt-4o"）
 */
export async function lookupPricingTiers(providerId: string, modelName: string): Promise<readonly PricingTier[]> {
  try {
    const result = await db.query<{ pricing_tiers: PricingTier[] }>(
      'SELECT pricing_tiers FROM provider_models WHERE provider_id = $1 AND name = $2 LIMIT 1',
      [providerId, modelName],
    );
    const row = result.rows[0];
    if (!row || !Array.isArray(row.pricing_tiers) || row.pricing_tiers.length === 0) {
      return [];
    }
    return row.pricing_tiers;
  } catch (error) {
    logger.error({ err: error, providerId, modelName }, 'Failed to lookup pricing tiers');
    return [];
  }
}
