# src/db/billing — 计费模块

> 父模块：参见 [db/README.md](../README.md)

## 简介

提供后置计费功能，根据提供商返回的实际 Token 用量和模型的阶梯价格计算本次请求费用。计费逻辑为纯函数设计，不操作数据库，便于单元测试。

## 目录结构

```
billing/
├── calculator.ts   # calculatePostBillingCost() — 后置费用计算纯函数
├── lookup.ts       # lookupPricingTiers() — 从 provider_models 表查询阶梯价格
└── index.ts        # 统一导出
```

## 核心接口

| 函数 | 说明 |
|---|---|
| `calculatePostBillingCost(usage, pricingTiers)` | 纯函数：根据 Token 用量和阶梯价格计算 `CostBreakdown` 和 `BillingResult` |
| `lookupPricingTiers(providerModelId)` | 查询 `provider_models` 表中对应模型的 `pricing_tiers` JSONB 字段 |

## 阶梯计费逻辑

1. 调用 `lookupPricingTiers()` 获取模型的阶梯价格配置
2. 将实际 `prompt_tokens`、`completion_tokens` 代入阶梯区间计算费用
3. 汇总为 `BillingResult`，写入 `gateway_context.billing` JSONB 字段

类型定义参见 [`src/types/billing.ts`](../../types/billing.ts)。
