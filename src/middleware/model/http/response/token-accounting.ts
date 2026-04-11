// src/middleware/response/token-accounting.ts — TPM Token 结算中间件
//
// 在提供商响应完成后执行，从响应体中提取实际 Token 消耗量，
// 更新虚拟模型和提供商模型两个维度的 TPM 计数器。

import { configManager } from '@/config';
import type { ModelHttpContext } from '@/types';
import { createLogger, logColors, rateLimiter } from '@/utils';

const logger = createLogger('Middleware:TokenAccounting', logColors.bold + logColors.gray);

/**
 * 从 ctx.response 中提取总 Token 消耗量
 *
 * 支持 Chat（ChatUsage.total_tokens）和 Embedding（EmbeddingUsage.total_tokens）两种响应格式。
 * 无 usage 字段时返回 0（不计入 TPM）。
 */
function extractTotalTokens(ctx: ModelHttpContext): number {
  if (!ctx.response) {
    return 0;
  }

  // Chat 和 Embedding 响应均通过 usage.total_tokens 统一访问
  if ('usage' in ctx.response && ctx.response.usage !== undefined) {
    return ctx.response.usage.total_tokens;
  }

  return 0;
}

/**
 * TPM Token 结算中间件
 *
 * 执行时机：提供商响应接收完毕、流式 chunks 合并后
 *
 * 职责：
 * 从实际响应中提取 Token 消耗量，更新虚拟模型和提供商模型两个维度的 TPM 计数器。
 * RPM 已在请求中间件中扣减，此处仅负责 TPM。
 */
export function tokenAccounting(ctx: ModelHttpContext): void {
  const totalTokens = extractTotalTokens(ctx);

  if (totalTokens <= 0) {
    return;
  }

  const vmConfig = configManager.getVirtualModelConfig(ctx.requestModel);
  if (!vmConfig) {
    return;
  }

  // 虚拟模型维度 TPM 扣减
  rateLimiter.incrementTpm('vm', vmConfig.id, totalTokens);

  // 提供商模型维度 TPM 扣减
  if (ctx.route) {
    const { model, providerId } = ctx.route;
    const backend = vmConfig.backends.find((b) => b.actualModel === model && b.provider.id === providerId);
    if (backend) {
      rateLimiter.incrementTpm('pm', backend.providerModelId, totalTokens);
    }
  }

  logger.debug(
    {
      requestId: ctx.id,
      virtualModel: ctx.requestModel,
      totalTokens,
    },
    'TPM counters updated',
  );
}
