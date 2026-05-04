// src/config/router.ts — 路由解析、能力过滤、流控感知

import type { ResolvedRoute, VirtualModelBackend, VirtualModelConfig } from '@/types';
import { createLogger, logColors, rateLimiter } from '@/utils';

const logger = createLogger('Config:Router', logColors.bold + logColors.yellow);

// ========== 能力过滤 ==========

/**
 * 按能力标识过滤后端列表
 * 后端必须拥有所有 requiredCapabilities 中列出的能力才被保留
 */
export function filterByCapabilities(
  backends: VirtualModelBackend[],
  requiredCapabilities: string[],
): VirtualModelBackend[] {
  if (requiredCapabilities.length === 0) {
    return backends;
  }
  return backends.filter((b) => requiredCapabilities.every((cap) => b.capabilities.includes(cap)));
}

// ========== 参数匹配排序 ==========

/**
 * 软排序：按后端声明的 supported_parameters 与请求所需参数的匹配度排序
 * 全部满足的后端排在前面；无法完全满足的后端降级但不淘汰。
 */
export function scoreByParameters(backends: VirtualModelBackend[], requiredParams: string[]): VirtualModelBackend[] {
  if (requiredParams.length === 0) {
    return backends;
  }
  return [...backends].sort((a, b) => {
    const scoreA = requiredParams.filter((p) => a.supportedParameters.includes(p)).length;
    const scoreB = requiredParams.filter((p) => b.supportedParameters.includes(p)).length;
    return scoreB - scoreA; // 降序，满足更多的排前面
  });
}

// ========== 流控过滤 ==========

/**
 * 按实时流控状态过滤后端列表
 * 剔除 RPM 或 TPM 任一已达到上限的后端（通过 rateLimiter 实时检测）
 * 包含模型级和提供商级两层限制：
 * - 模型级（pm）：针对单个 providerModelId 的独立限制
 * - 提供商级（p）：共享同一 provider.id 的全局并发限制
 */
export function filterByRateLimit(backends: VirtualModelBackend[]): VirtualModelBackend[] {
  return backends.filter((b) => {
    // 模型级限流
    const pmRpmFull = rateLimiter.isRpmFull('pm', b.providerModelId, b.rpmLimit);
    const pmTpmFull = rateLimiter.isTpmFull('pm', b.providerModelId, b.tpmLimit);
    if (pmRpmFull || pmTpmFull) {
      logger.debug(
        { providerModelId: b.providerModelId, actualModel: b.actualModel, pmRpmFull, pmTpmFull },
        'Backend excluded by model-level rate limit',
      );
      return false;
    }
    // 提供商级限流
    const pRpmFull = rateLimiter.isRpmFull('p', b.provider.id, b.provider.rpmLimit);
    const pTpmFull = rateLimiter.isTpmFull('p', b.provider.id, b.provider.tpmLimit);
    if (pRpmFull || pTpmFull) {
      logger.debug(
        { providerId: b.provider.id, providerModelId: b.providerModelId, pRpmFull, pTpmFull },
        'Backend excluded by provider-level rate limit',
      );
      return false;
    }
    return true;
  });
}

// ========== 路由解析 ==========

/**
 * 将 VirtualModelBackend 转换为 ResolvedRoute
 */
function toRoute(backend: VirtualModelBackend, config: VirtualModelConfig): ResolvedRoute {
  return {
    actualModel: backend.actualModel,
    modelType: config.modelType,
    capabilities: backend.capabilities,
    supportedParameters: backend.supportedParameters,
    providerKind: backend.provider.kind,
    providerId: backend.provider.id,
    provider: backend.provider,
    requestOverrides: backend.requestOverrides,
    routingStrategy: config.routingStrategy,
    timeoutMs: backend.timeoutMs,
    modelConfig: backend.modelConfig,
  };
}

/**
 * 获取虚拟模型的候选后端列表（路由模块和 caller 共用）
 *
 * 流控感知路由策略：
 * 1. 先按能力标识过滤不满足的后端
 * 2. 再剔除 RPM 或 TPM 任一已满载的后端（通过 rateLimiter 实时检测）
 * 3. 按策略选择后端：
 *    - load_balance: 按权重降序排列，选第一个（权重最高的可用后端）
 *    - failover:     按 priority 升序，选第一个可用后端
 *
 * 所有策略均只返回单个后端，调用失败即返回错误。
 */
export function resolveAllBackends(
  config: VirtualModelConfig,
  requiredCapabilities: string[] = [],
  requiredParameters: string[] = [],
): ResolvedRoute[] {
  if (config.backends.length === 0) {
    return [];
  }

  const eligible = filterByCapabilities(config.backends, requiredCapabilities);
  const scored = scoreByParameters(eligible, requiredParameters);

  // 流控感知过滤：剔除 RPM 或 TPM 任一已满载的后端
  const available = filterByRateLimit(scored);

  if (available.length === 0 && eligible.length > 0) {
    logger.warn({ eligibleCount: eligible.length }, 'All backends rate-limited for virtual model');
  }

  if (config.routingStrategy === 'load_balance') {
    // 按权重降序排列，选第一个（权重最高的可用后端）
    const sorted = [...available].sort((a, b) => b.weight - a.weight);
    const chosen = sorted[0];
    return chosen === undefined ? [] : [toRoute(chosen, config)];
  }

  // failover：按 priority 升序取第一个可用后端（已按 priority 排序）
  return available[0] === undefined ? [] : [toRoute(available[0], config)];
}
