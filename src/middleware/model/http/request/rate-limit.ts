// src/middleware/request/rate-limit.ts — RPM/TPM 流控中间件
//
// 在路由解析完成后执行，检查虚拟模型级别的 RPM/TPM 限制。
// 提供商模型级别的限制已在路由选择阶段（ConfigManager.filterByRateLimit）自动剔除。
// 本中间件仅负责虚拟模型层面的宏观防护，以及对通过的请求进行 RPM 计数扣减。

import { configManager } from '@/config';
import type { ModelHttpContext } from '@/types';
import { createLogger, GatewayError, logColors, rateLimiter } from '@/utils';

const logger = createLogger('Middleware:RateLimit', logColors.bold + logColors.gray);

/**
 * RPM/TPM 流控中间件
 *
 * 执行时机：路由解析完成后（ctx.route 已填充）
 *
 * 职责：
 * 1. 检查虚拟模型级别的 RPM/TPM 限制，超标则返回 429
 * 2. 对通过的请求，在虚拟模型和提供商模型两个维度各扣减 RPM +1
 *
 * TPM 扣减在响应中间件（token-accounting.ts）中完成，
 * 因为真正消耗的 Token 数只有在提供商响应后才能确定。
 */
export function rateLimit(ctx: ModelHttpContext): void {
  const vmConfig = configManager.getVirtualModelConfig(ctx.requestModel);
  if (!vmConfig) {
    // 虚拟模型不存在：路由阶段已经会抛出 404，这里是防御性检查
    return;
  }

  const vmId = vmConfig.id;

  // ========== 虚拟模型级别 RPM 检查 ==========
  if (rateLimiter.isRpmFull('vm', vmId, vmConfig.rpmLimit)) {
    logger.warn(
      { requestId: ctx.id, virtualModel: ctx.requestModel, rpmLimit: vmConfig.rpmLimit },
      'Virtual model RPM limit exceeded',
    );
    throw new GatewayError(
      429,
      'rate_limit_exceeded',
      `Model "${ctx.requestModel}" has exceeded its RPM limit (${String(vmConfig.rpmLimit)} requests/min)`,
    );
  }

  // ========== 虚拟模型级别 TPM 检查 ==========
  if (rateLimiter.isTpmFull('vm', vmId, vmConfig.tpmLimit)) {
    logger.warn(
      { requestId: ctx.id, virtualModel: ctx.requestModel, tpmLimit: vmConfig.tpmLimit },
      'Virtual model TPM limit exceeded',
    );
    throw new GatewayError(
      429,
      'rate_limit_exceeded',
      `Model "${ctx.requestModel}" has exceeded its TPM limit (${String(vmConfig.tpmLimit)} tokens/min)`,
    );
  }

  // ========== RPM 扣减（虚拟模型 + 提供商模型） ==========
  rateLimiter.incrementRpm('vm', vmId);

  // 提供商模型的 RPM 扣减需要路由结果
  if (ctx.route) {
    // 通过 route 反查 providerModelId：查找匹配的后端
    const { model, providerId } = ctx.route;
    const backend = vmConfig.backends.find((b) => b.actualModel === model && b.provider.id === providerId);
    if (backend) {
      rateLimiter.incrementRpm('pm', backend.providerModelId);
    }
  }

  logger.debug(
    { requestId: ctx.id, virtualModel: ctx.requestModel },
    'Rate limit check passed, RPM counters incremented',
  );
}
