// src/router/index.ts — 路由与虚拟模型映射

import { configManager } from '@/config';
import type {
  InternalChatRequest,
  InternalEmbeddingRequest,
  ModelHttpContext,
  ModelType,
  RoutedModelHttpContext,
} from '@/types';
import { createLogger, GatewayError, logColors } from '@/utils';

const logger = createLogger('Router', logColors.bold + logColors.cyan);

// ==================== 能力推断 ====================

/**
 * 从 Chat 请求中推断所需的模型能力标识
 *
 * 规则：
 * - 消息中包含图片/视频/音频/文件等多模态内容 → 'vision'
 * - 请求定义了工具 (tools) → 'tools'
 * - 启用了深度思考 (thinking.type !== 'disabled') → 'thinking'
 */
function inferChatCapabilities(req: InternalChatRequest): string[] {
  const caps: string[] = [];

  // 检查消息是否包含多模态内容
  const hasMedia = req.messages.some((msg) => {
    if (!Array.isArray(msg.content)) {
      return false;
    }
    return msg.content.some((part) => part.type !== 'text');
  });
  if (hasMedia) {
    caps.push('vision');
  }

  // 检查是否使用工具
  if (req.tools !== undefined && req.tools.length > 0) {
    caps.push('tools');
  }

  // 检查是否启用深度思考
  if (req.thinking?.type !== undefined && req.thinking.type !== 'disabled') {
    caps.push('thinking');
  }

  return caps;
}

/**
 * 从 Embedding 请求中推断所需的模型能力标识
 *
 * 规则：
 * - 输入中包含图像或视频 → 'multimodal'
 * - 请求启用了稀疏向量 (sparse_embedding='enabled') → 'sparse_vector'
 */
function inferEmbeddingCapabilities(req: InternalEmbeddingRequest): string[] {
  const caps: string[] = [];

  // 检查输入是否包含非文本内容（图像或视频）
  const hasNonText = req.input.some((item) => item.type !== 'text');
  if (hasNonText) {
    caps.push('multimodal');
  }

  // 检查是否启用稀疏向量
  if (req.sparse_embedding === 'enabled') {
    caps.push('sparse_vector');
  }

  return caps;
}

/**
 * 从 ModelHttpContext 推断请求所需的能力标识
 * 根据 ctx.request 的实际类型分派到对应的推断函数
 */
function inferRequiredCapabilities(ctx: ModelHttpContext): string[] {
  if (!ctx.request) {
    return [];
  }

  // 通过字段特征区分 Chat / Embedding 请求
  if ('messages' in ctx.request) {
    return inferChatCapabilities(ctx.request);
  }
  if ('input' in ctx.request) {
    return inferEmbeddingCapabilities(ctx.request);
  }

  return [];
}

// ==================== 参数推断 ====================

/**
 * 从 Chat 请求中推断用户实际传入的调优参数集合（用于软排序后端选择）
 * 只推断用户明确传入的参数，而非全量可能参数。
 */
function inferChatRequiredParameters(req: InternalChatRequest): string[] {
  const params: string[] = [];
  if (req.temperature !== undefined) {
    params.push('temperature');
  }
  if (req.top_p !== undefined) {
    params.push('top_p');
  }
  if (req.top_k !== undefined) {
    params.push('top_k');
  }
  if (req.frequency_penalty !== undefined) {
    params.push('frequency_penalty');
  }
  if (req.presence_penalty !== undefined) {
    params.push('presence_penalty');
  }
  if (req.stop !== undefined) {
    params.push('stop');
  }
  return params;
}

// ==================== 路由 ====================

/**
 * 路由函数：读取 ctx.requestModel，通过 ConfigManager 解析路由，
 * 将 routedModel、modelType、providerKind、providerId 写入 ctx。
 *
 * @param expectedModelType 预期模型类型。若提供，会在路由解析前提前校验虚拟模型的
 *   model_type 是否匹配，不匹配时直接抛出错误，避免无意义的能力推断和后端选择。
 *
 * 自动从 ctx.request 推断所需能力，过滤不满足的后端。
 * 若所有后端均不满足能力要求，抛出错误。
 *
 * 本方法仅做虚拟模型校验 + 能力推断 + 首个后端填充 ctx.route，
 * 实际的路由策略选择（加权随机/failover）由 caller 调用 resolveAllBackends 时完成。
 */
export function route(ctx: ModelHttpContext, expectedModelType?: ModelType): void {
  logger.debug({ requestModel: ctx.requestModel, requestId: ctx.id }, '[route] resolving...');

  // 提前校验虚拟模型类型（利用 virtual_models.model_type），
  // 在能力推断和后端选择之前即可拦截类型不匹配的请求
  const vmConfig = configManager.getVirtualModelConfig(ctx.requestModel);
  if (!vmConfig) {
    throw new GatewayError(404, 'model_not_found', `Unknown model: ${ctx.requestModel}`);
  }

  if (expectedModelType && vmConfig.modelType !== expectedModelType) {
    throw new GatewayError(
      400,
      'model_type_mismatch',
      `Model "${ctx.requestModel}" is a ${vmConfig.modelType} model, not a ${expectedModelType} model`,
    );
  }

  const requiredCaps = inferRequiredCapabilities(ctx);
  const requiredParams = ctx.request && 'messages' in ctx.request ? inferChatRequiredParameters(ctx.request) : [];

  if (requiredCaps.length > 0) {
    logger.debug(
      { requestId: ctx.id, requiredCapabilities: requiredCaps, requiredParams },
      'Inferred required capabilities and parameters from request',
    );
  }

  // 直接使用 resolveAllBackends 完成路由（避免 resolveRoute + resolveAllBackends 双重解析）
  const candidates = configManager.resolveAllBackends(ctx.requestModel, requiredCaps, requiredParams);
  if (candidates.length === 0) {
    // 虚拟模型存在但无后端满足能力要求
    if (vmConfig.backends.length > 0 && requiredCaps.length > 0) {
      throw new GatewayError(
        400,
        'capability_not_supported',
        `No backend for model "${ctx.requestModel}" supports the required capabilities: ${requiredCaps.join(', ')}`,
      );
    }

    // 虚拟模型存在但所有后端不可用（inactive 等）
    throw new GatewayError(503, 'no_backend_available', `No active backends for model: ${ctx.requestModel}`);
  }

  // candidates.length > 0 已在上方分支保证
  const selected = candidates[0];
  if (!selected) {
    throw new GatewayError(500, 'internal_error', 'Candidates list is empty unexpectedly after check');
  }
  ctx.route = {
    model: selected.actualModel,
    modelType: selected.modelType,
    providerKind: selected.providerKind,
    providerId: selected.providerId,
    providerConfig: selected.provider,
    strategy: selected.routingStrategy,
    capabilities: requiredCaps,
    supportedParameters: selected.supportedParameters,
    timeoutMs: selected.timeoutMs,
  };
  ctx.timing.routed = Date.now();

  logger.debug(
    {
      requestId: ctx.id,
      requestModel: ctx.requestModel,
      routedModel: selected.actualModel,
      provider: selected.providerKind,
      providerId: selected.providerId,
      modelType: selected.modelType,
      requiredCapabilities: requiredCaps.length > 0 ? requiredCaps : undefined,
      backendCapabilities: selected.capabilities,
    },
    '[route] resolved',
  );
}

/**
 * 类型守卫：断言路由已解析完成
 * 调用后 TypeScript 将所有路由字段类型收窄为非 undefined
 */
export function assertRouted(ctx: ModelHttpContext): asserts ctx is RoutedModelHttpContext {
  if (ctx.route === undefined) {
    throw new GatewayError(500, 'route_error', 'Route resolved but missing routing fields');
  }
}
