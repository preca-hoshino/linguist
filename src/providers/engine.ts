// src/providers/engine.ts — 提供商调用核心引擎与 HTTP 解析

import { configManager } from '@/config';
import type {
  GatewayContext,
  InternalChatRequest,
  InternalChatResponse,
  InternalChatStreamChunk,
  InternalEmbeddingRequest,
  InternalEmbeddingResponse,
  ProviderCallResult,
  ProviderConfig,
  ResolvedRoute,
  RoutedGatewayContext,
} from '@/types';
import { createCachedLoggerFactory, GatewayError, logColors, parseSSEStream } from '@/utils';
import { fetchHeadersToRecord } from './http-utils';
import { getProviderChatAdapterSet, getProviderEmbeddingAdapterSet } from './index';
import type { ProviderChatStreamResponseAdapter } from './types';

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

function sanitizeProviderError(detail: string): string {
  const stripped = detail.replace(/^\w[\w\s]* API returned \d+:\s*/i, '');
  return stripped.length > 0 ? stripped : 'Provider request failed';
}

// ========== 框架引擎: 泛型内部实现 ==========

interface AdapterSet<TReq, TRes> {
  requestAdapter: { toProviderRequest: (req: TReq, model: string) => Record<string, unknown> };
  responseAdapter: { fromProviderResponse: (res: unknown) => TRes };
  client: { call: (req: Record<string, unknown>, model: string) => Promise<ProviderCallResult> };
}

type GetAdapterSet<TReq, TRes> = (providerKind: string, providerConfig: ProviderConfig) => AdapterSet<TReq, TRes>;
type InternalResponse = InternalChatResponse | InternalEmbeddingResponse;

export async function callProvider<TReq, TRes extends InternalResponse>(
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

async function dispatchProvider<TReq, TRes extends InternalResponse>(
  ctx: GatewayContext,
  request: TReq,
  getAdapterSet: GetAdapterSet<TReq, TRes>,
  label: string,
  executor: typeof callProvider,
): Promise<void> {
  // 单元测试友好：如果 route 尚未完整（缺少 capabilities），则执行后端解析逻辑
  if (ctx.route?.capabilities === undefined) {
    const candidates = configManager.resolveAllBackends(ctx.requestModel, ctx.route?.capabilities);
    const candidate = candidates[0];

    if (!candidate) {
      throw new GatewayError(
        503,
        'no_available_backend',
        `No available ${label.toLowerCase()} backends for model: ${ctx.requestModel}`,
      );
    }

    // 利用 ResolvedRoute 的完整字段填充路由——确保类型完整性
    ctx.route = {
      model: candidate.actualModel,
      modelType: candidate.modelType,
      providerKind: candidate.providerKind,
      providerId: candidate.providerId,
      providerConfig: candidate.provider,
      strategy: candidate.routingStrategy,
      capabilities: candidate.capabilities,
    };
  }

  // 经过上方的 if 块（或入参本身已完整），此处 route 已保证填充完毕
  const routedCtx = ctx as RoutedGatewayContext;

  const providerLogger = getProviderLogger(routedCtx.route.providerKind);
  try {
    await executor(routedCtx, request, getAdapterSet, label);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    providerLogger.warn(
      { requestId: routedCtx.id, model: routedCtx.route.model, strategy: routedCtx.route.strategy, error: detail },
      `${routedCtx.route.strategy}: ${label.toLowerCase()} provider call failed`,
    );

    if (error instanceof GatewayError && error.providerDetail !== undefined) {
      routedCtx.providerError = error.providerDetail;
    }

    const sanitizedMessage = sanitizeProviderError(detail);

    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new GatewayError(504, 'provider_timeout', 'Provider request timed out');
    }

    if (error instanceof GatewayError) {
      throw new GatewayError(error.statusCode, error.errorCode, sanitizedMessage);
    }
    throw new GatewayError(502, 'provider_error', sanitizedMessage);
  }
}

// ========== 框架引擎: 公开入口 ==========

export async function dispatchChatProvider(
  ctx: GatewayContext,
  chatRequest: InternalChatRequest,
  executor: typeof callProvider = callProvider,
): Promise<void> {
  await dispatchProvider<InternalChatRequest, InternalChatResponse>(
    ctx,
    chatRequest,
    getProviderChatAdapterSet,
    'Chat',
    executor,
  );
}

export async function dispatchEmbeddingProvider(
  ctx: GatewayContext,
  embeddingRequest: InternalEmbeddingRequest,
  executor: typeof callProvider = callProvider,
): Promise<void> {
  await dispatchProvider<InternalEmbeddingRequest, InternalEmbeddingResponse>(
    ctx,
    embeddingRequest,
    getProviderEmbeddingAdapterSet,
    'Embedding',
    executor,
  );
}

// ========== 框架引擎: 流式调用 ==========

export interface StreamDispatchResult {
  stream: AsyncGenerator<InternalChatStreamChunk>;
}

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

  ctx.audit.providerRequest.headers = providerReqHeaders;
  ctx.audit.providerResponse = { headers: fetchHeadersToRecord(response.headers) };

  providerLogger.debug({ requestId: ctx.id, model: ctx.route.model }, '[dispatch] upstream stream connected');

  return { stream: createChunkGenerator(ctx, response, streamResponseAdapter) };
}

export async function dispatchChatProviderStream(
  ctx: RoutedGatewayContext,
  chatRequest: InternalChatRequest,
): Promise<StreamDispatchResult> {
  if (!ctx.id) {
    ctx.id = 'test-id';
  }
  const candidates = configManager.resolveAllBackends(ctx.requestModel, ctx.route.capabilities);
  const candidate = candidates[0];

  if (!candidate) {
    throw new GatewayError(503, 'no_available_backend', `No available chat backends for model: ${ctx.requestModel}`);
  }

  try {
    return await tryStreamConnect(ctx, chatRequest, candidate);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    getProviderLogger(candidate.providerKind).warn(
      { requestId: ctx.id, model: candidate.actualModel, strategy: ctx.route.strategy, error: detail },
      `${ctx.route.strategy}: chat stream provider call failed`,
    );

    if (error instanceof GatewayError && error.providerDetail !== undefined) {
      ctx.providerError = error.providerDetail;
    }

    const sanitizedMessage = sanitizeProviderError(detail);

    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new GatewayError(504, 'provider_timeout', 'Provider request timed out');
    }

    if (error instanceof GatewayError) {
      throw new GatewayError(error.statusCode, error.errorCode, sanitizedMessage);
    }
    throw new GatewayError(502, 'provider_error', sanitizedMessage);
  }
}

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
    } catch (error) {
      providerLogger.warn(
        { requestId: ctx.id, error: error instanceof Error ? error.message : String(error) },
        'Failed to parse stream chunk, skipping',
      );
    }
  }

  ctx.timing.providerEnd = Date.now();
  /* istanbul ignore next -- fallback safety */
  const providerDuration =
    ctx.timing.providerStart === undefined ? undefined : ctx.timing.providerEnd - ctx.timing.providerStart;
  providerLogger.debug(
    {
      requestId: ctx.id,
      model: ctx.route.model,
      duration:
        /* istanbul ignore next -- fallback safety */ providerDuration === undefined ? 'N/A' : `${providerDuration}ms`,
    },
    '[dispatch] upstream stream completed',
  );
}
