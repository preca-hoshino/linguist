// src/types/billing.ts — 阶梯计费类型定义
//
// 企业级网关后置计费核心类型：
// - PricingTier：单条阶梯价格配置（存储在 provider_models.pricing_tiers JSONB）
// - CostBreakdown：单次请求的计费明细（存储在 request_logs.cost_breakdown JSONB）
// - BillingResult：计费计算结果（判别联合，确保调用方对成功/失败显式处理）

// ==================== 阶梯价格配置 ====================

/**
 * 阶梯计费配置（对应 provider_models.pricing_tiers JSONB 数组元素）
 *
 * 网关按照 usage.prompt_tokens 在各阶梯的 [startTokens, maxTokens) 区间中匹配，
 * 命中后取该阶梯的 inputPrice / outputPrice / cachePrice 三个维度进行结算。
 */
export interface PricingTier {
  /** 本阶梯适用的起始 Token 数（含），如 0 / 32000 / 128000 */
  readonly start_tokens: number;
  /** 本阶梯适用的上限 Token 数（不含）。null 表示无上限兜底档位 */
  readonly max_tokens: number | null;
  /** 每百万 Token 输入价格 */
  readonly input_price: number;
  /** 每百万 Token 输出价格 */
  readonly output_price: number;
  /** 每百万 Token 缓存命中价格 */
  readonly cache_price: number;
}

// ==================== 计费明细 ====================

/**
 * 单条请求的计费明细快照
 * 存入 request_logs.cost_breakdown 作为账单下钻的数据源
 */
export interface CostBreakdown {
  /** 命中的阶梯起始 Token 数（方便 UI 展示"命中 >32K 档位"） */
  readonly tierStartTokens: number;
  /** 输入部分费用（纯新输入 Token 的花费） */
  readonly inputCost: number;
  /** 缓存命中部分费用 */
  readonly cacheCost: number;
  /** 输出部分费用 */
  readonly outputCost: number;
}

// ==================== 计费结果（判别联合） ====================

/** 计费成功结果 */
interface BillingSuccess {
  readonly status: 'success';
  /** 总费用（6位小数精度） */
  readonly cost: number;
  /** 费用明细 */
  readonly breakdown: CostBreakdown;
}

/** 计费跳过结果（不报错，但不产生费用） */
interface BillingSkipped {
  readonly status: 'skipped';
  /** 跳过原因 */
  readonly reason: 'no_tiers' | 'no_usage' | 'error_request';
}

/**
 * 计费计算结果（判别联合）
 *
 * 调用方通过 switch(result.status) 处理：
 * - 'success'：包含 cost + breakdown
 * - 'skipped'：无费用产生（未配置阶梯/无 usage/错误请求）
 */
export type BillingResult = BillingSuccess | BillingSkipped;
