// src/providers/caller.ts — 提供商调用逻辑（所有策略均单次调用，失败即返回错误）

import type {
  RoutedGatewayContext,
  InternalChatRequest,
  InternalEmbeddingRequest,
  InternalChatResponse,
  InternalEmbeddingResponse,
  InternalChatStreamChunk,
  ResolvedRoute,
  ProviderConfig,
  ProviderCallResult,
} from '../types';
import type { ProviderChatStreamResponseAdapter } from './chat';
import { getProviderChatAdapterSet, getProviderEmbeddingAdapterSet } from './index';
import { configManager } from '../config';
import { GatewayError, createCachedLoggerFactory, logColors, parseSSEStream } from '../utils';
import { fetchHeadersToRecord } from './response-parser';

// ========== 动态 Provider Logger ==========

/** 根据 providerKind 获取（或创建）对应的 Logger */
const getProviderLogger = createCachedLoggerFactory(
  {
    deepseek: { label: 'Provider:DeepSeek', color: logColors.bold + logColors.green },
    gemini: { label: 'Provider:Gemini', color: logColors.bold + logColors.yellow },
    volcengine: { label: 'Provider:VolcEngine', color: logColors.bold + logColors.magenta },
  },
  'Provider',
  logColors.bold + logColors.white,
);

// ========== 错误消息脱敏 ==========

/**
 * 从提供商错误消息中移除内部提供商名称和实际模型名，
 * 只保留有用的错误描述（如参数校验失败原因），防止泄露内部路由信息。
 */
function sanitizeProviderError(detail: string): string {
  // 移除 "ProviderName API returned NNN: " 前缀
  const stripped = detail.replace(/^\w[\w\s]* API returned \d+:\s*/i, '');
  // 返回精简后的信息（保留提供商返回的实际错误描述）
  return stripped.length > 0 ? stripped : 'Provider request failed';
}

// ========== 类型定义 ==========

/** 适配器三件套的统一抽象（Chat 和 Embedding 共用） */
interface AdapterSet<TReq, TRes> {
  requestAdapter: { toProviderRequest(req: TReq, model: string): Record<string, unknown> };
  responseAdapter: { fromProviderResponse(res: unknown): TRes };
  client: { call(req: Record<string, unknown>, model: string): Promise<ProviderCallResult> };
}

/** 适配器三件套获取函数 */
type GetAdapterSet<TReq, TRes> = (providerKind: string, providerConfig: ProviderConfig) => AdapterSet<TReq, TRes>;

/** 内部响应联合类型 */
type InternalResponse = InternalChatResponse | InternalEmbeddingResponse;

// ========== 泛型内部实现 ==========

/**
 * 调用单个提供商后端（通用逻辑）
 */
async function callProvider<TReq, TRes extends InternalResponse>(
  ctx: RoutedGatewayContext,
  request: TReq,
  getAdapterSet: GetAdapterSet<TReq, TRes>,
  label: string,
): Promise<void> {
  const providerLogger = getProviderLogger(ctx.route.providerKind);
  const { requestAdapter, responseAdapter, client } = getAdapterSet(ctx.route.providerKind, ctx.route.providerConfig);
  providerLogger.debug({ requestId: ctx.id }, `[dispatch] ${label.toLowerCase()} adapter initialized`);

  const providerReqBody = requestAdapter.toProviderRequest(request, ctx.route.model);
  ctx.audit.providerRequest = { body: providerReqBody };
  providerLogger.debug({ requestId: ctx.id }, `[dispatch] ${label.toLowerCase()} request serialized`);

  ctx.timing.providerStart = Date.now();
  providerLogger.debug({ requestId: ctx.id, model: ctx.route.model }, '[dispatch] forwarding to upstream');
  const result = await client.call(providerReqBody, ctx.route.model);
  ctx.timing.providerEnd = Date.now();

  // 记录提供商双向头部 + 响应体
  ctx.audit.providerRequest.headers = result.requestHeaders;
  ctx.audit.providerResponse = { headers: result.responseHeaders, body: result.body };

  const providerDuration = ctx.timing.providerEnd - ctx.timing.providerStart;
  providerLogger.debug(
    { requestId: ctx.id, model: ctx.route.model, duration: `${providerDuration}ms` },
    '[dispatch] upstream responded',
  );

  ctx.response = responseAdapter.fromProviderResponse(result.body);
  providerLogger.debug({ requestId: ctx.id }, '[adapt] provider response → internal format');
}

/**
 * 统一分派入口（通用逻辑）
 *
 * 所有策略均单次调用，失败即返回清晰错误，不重试。
 * candidates 数组已由 configManager.resolveAllBackends() 按策略选出唯一后端。
 */
async function dispatchProvider<TReq, TRes extends InternalResponse>(
  ctx: RoutedGatewayContext,
  request: TReq,
  getAdapterSet: GetAdapterSet<TReq, TRes>,
  label: string,
): Promise<void> {
  const candidates = configManager.resolveAllBackends(ctx.requestModel, ctx.route.capabilities);
  const candidate = candidates[0];

  if (!candidate) {
    throw new GatewayError(
      503,
      'no_available_backend',
      `No available ${label.toLowerCase()} backends for model: ${ctx.requestModel}`,
    );
  }

  // 更新 ctx 为选中的后端
  ctx.route = {
    ...ctx.route,
    model: candidate.actualModel,
    providerKind: candidate.providerKind,
    providerId: candidate.providerId,
    providerConfig: candidate.provider,
  };

  const providerLogger = getProviderLogger(ctx.route.providerKind);
  try {
    await callProvider(ctx, request, getAdapterSet, label);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    providerLogger.warn(
      { requestId: ctx.id, model: ctx.route.model, strategy: ctx.route.strategy, error: detail },
      `${ctx.route.strategy}: ${label.toLowerCase()} provider call failed`,
    );

    // 将提供商原始错误详情存入 ctx 用于审计
    if (err instanceof GatewayError && err.providerDetail !== undefined) {
      ctx.providerError = err.providerDetail;
    }

    const sanitizedMessage = sanitizeProviderError(detail);

    // 检测超时错误
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new GatewayError(504, 'provider_timeout', 'Provider request timed out');
    }

    if (err instanceof GatewayError) {
      throw new GatewayError(err.statusCode, err.errorCode, sanitizedMessage);
    }
    throw new GatewayError(502, 'provider_error', sanitizedMessage);
  }
}

// ========== 公开入口 ==========

/** 分派聊天提供商调用（结果写入 ctx.response + ctx.audit） */
export async function dispatchChatProvider(ctx: RoutedGatewayContext, chatRequest: InternalChatRequest): Promise<void> {
  await dispatchProvider<InternalChatRequest, InternalChatResponse>(
    ctx,
    chatRequest,
    getProviderChatAdapterSet,
    'Chat',
  );
}

/** 分派嵌入提供商调用（结果写入 ctx.response + ctx.audit） */
export async function dispatchEmbeddingProvider(
  ctx: RoutedGatewayContext,
  embeddingRequest: InternalEmbeddingRequest,
): Promise<void> {
  await dispatchProvider<InternalEmbeddingRequest, InternalEmbeddingResponse>(
    ctx,
    embeddingRequest,
    getProviderEmbeddingAdapterSet,
    'Embedding',
  );
}

// ========== 流式调用 ==========

/**
 * 流式分派结果
 * 连接建立成功后返回异步 chunk 生成器，调用方迭代生成器获取 InternalChatStreamChunk
 */
export interface StreamDispatchResult {
  stream: AsyncGenerator<InternalChatStreamChunk>;
}

/**
 * 尝试与单个候选后端建立流式连接
 * 成功时返回 StreamDispatchResult，失败时抛出（含清晰错误信息）
 */
async function tryStreamConnect(
  ctx: RoutedGatewayContext,
  chatRequest: InternalChatRequest,
  candidate: ResolvedRoute,
): Promise<StreamDispatchResult> {
  ctx.route = {
    ...ctx.route,
    model: candidate.actualModel,
    providerKind: candidate.providerKind,
    providerId: candidate.providerId,
    providerConfig: candidate.provider,
  };

  const providerLogger = getProviderLogger(ctx.route.providerKind);
  const { requestAdapter, streamResponseAdapter, client } = getProviderChatAdapterSet(
    ctx.route.providerKind,
    ctx.route.providerConfig,
  );
  providerLogger.debug({ requestId: ctx.id }, '[dispatch] stream adapter initialized');

  const providerReqBody = requestAdapter.toProviderRequest(chatRequest, ctx.route.model);
  ctx.audit.providerRequest = { body: providerReqBody };
  providerLogger.debug({ requestId: ctx.id }, '[dispatch] stream request serialized');

  ctx.timing.providerStart = Date.now();
  providerLogger.debug({ requestId: ctx.id, model: ctx.route.model }, '[dispatch] forwarding to upstream (stream)');

  const { response, requestHeaders: providerReqHeaders } = await client.callStream(providerReqBody, ctx.route.model);

  // 记录提供商双向头部
  ctx.audit.providerRequest.headers = providerReqHeaders;
  ctx.audit.providerResponse = { headers: fetchHeadersToRecord(response.headers) };

  providerLogger.debug({ requestId: ctx.id, model: ctx.route.model }, '[dispatch] upstream stream connected');

  return { stream: createChunkGenerator(ctx, response, streamResponseAdapter) };
}

/**
 * 分派聊天提供商流式调用
 *
 * 所有策略均单次连接，失败即返回清晰错误，不重试。
 * 一旦连接建成（HTTP 200），返回异步生成器供调用方迭代。
 */
export async function dispatchChatProviderStream(
  ctx: RoutedGatewayContext,
  chatRequest: InternalChatRequest,
): Promise<StreamDispatchResult> {
  const candidates = configManager.resolveAllBackends(ctx.requestModel, ctx.route.capabilities);
  const candidate = candidates[0];

  if (!candidate) {
    throw new GatewayError(503, 'no_available_backend', `No available chat backends for model: ${ctx.requestModel}`);
  }

  try {
    return await tryStreamConnect(ctx, chatRequest, candidate);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    getProviderLogger(candidate.providerKind).warn(
      { requestId: ctx.id, model: candidate.actualModel, strategy: ctx.route.strategy, error: detail },
      `${ctx.route.strategy}: chat stream provider call failed`,
    );

    // 将提供商原始错误详情存入 ctx 用于审计
    if (err instanceof GatewayError && err.providerDetail !== undefined) {
      ctx.providerError = err.providerDetail;
    }

    const sanitizedMessage = sanitizeProviderError(detail);

    // 检测超时错误
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new GatewayError(504, 'provider_timeout', 'Provider request timed out');
    }

    if (err instanceof GatewayError) {
      throw new GatewayError(err.statusCode, err.errorCode, sanitizedMessage);
    }
    throw new GatewayError(502, 'provider_error', sanitizedMessage);
  }
}

/**
 * 创建异步 chunk 生成器
 * 从 SSE 流中解析 JSON 数据行，经提供商流式适配器转换为 InternalChatStreamChunk
 */
async function* createChunkGenerator(
  ctx: RoutedGatewayContext,
  response: globalThis.Response,
  streamResponseAdapter: ProviderChatStreamResponseAdapter,
): AsyncGenerator<InternalChatStreamChunk> {
  const providerLogger = getProviderLogger(ctx.route.providerKind);
  if (!response.body) {
    providerLogger.warn({ requestId: ctx.id }, 'Stream response has no body');
    return;
  }

  for await (const dataLine of parseSSEStream(response.body)) {
    try {
      const providerChunk = JSON.parse(dataLine) as unknown;
      yield streamResponseAdapter.fromProviderStreamChunk(providerChunk);
    } catch (parseErr) {
      providerLogger.warn(
        { requestId: ctx.id, error: parseErr instanceof Error ? parseErr.message : String(parseErr) },
        'Failed to parse stream chunk, skipping',
      );
    }
  }

  ctx.timing.providerEnd = Date.now();
  const providerDuration =
    ctx.timing.providerStart !== undefined ? ctx.timing.providerEnd - ctx.timing.providerStart : undefined;
  providerLogger.debug(
    {
      requestId: ctx.id,
      model: ctx.route.model,
      duration: providerDuration !== undefined ? `${providerDuration}ms` : 'N/A',
    },
    '[dispatch] upstream stream completed',
  );
}
