// src/model/http/providers/engine/core.ts — 提供商调用核心引擎

import { configManager } from '@/config';
import type {
  InternalChatRequest,
  InternalChatResponse,
  InternalChatStreamChunk,
  InternalEmbeddingRequest,
  InternalEmbeddingResponse,
  ProviderCallResult,
  ProviderConfig,
  ResolvedRoute,
  RoutedModelHttpContext,
} from '@/types';
import { GatewayError } from '@/utils';
import { fetchHeadersToRecord } from '../http-utils';
import { getProviderChatAdapterSet, getProviderEmbeddingAdapterSet } from '../index';
import type { ProviderCallOptions } from '../types';
import { cacheReasoningContent } from '../deepseek/reasoning-cache';
import { applyBodyOverrides, stripUnsupportedChatParams, stripUnsupportedEmbeddingParams } from './strip';
import { handleProviderError } from './errors';
import { getProviderLogger } from './logger';
import { createChunkGenerator } from './stream';

// ========== 推理内容缓存 ==========

/**
 * 若当前请求属于 DeepSeek 推理模型且开启了 reasoning_content_backfill，
 * 从响应中提取 reasoning_content 按 assistant content 缓存供后续多轮对话自动回填。
 */
export function cacheReasoningFromResponse(ctx: RoutedModelHttpContext): void {
  if (ctx.route.providerKind !== 'deepseek') {
    return;
  }
  if (ctx.route.modelConfig?.reasoning_content_backfill !== true) {
    return;
  }
  const response = ctx.response as InternalChatResponse | undefined;
  if (!response?.choices) {
    return;
  }
  for (const choice of response.choices) {
    const content = choice.message.content;
    const reasoning = choice.message.reasoning_content;
    if (typeof content === 'string' && typeof reasoning === 'string') {
      cacheReasoningContent(content, reasoning);
    }
  }
}

// ========== 框架引擎: 泛型内部实现 ==========

interface AdapterSet<TReq, TRes> {
  requestAdapter: {
    toProviderRequest: (req: TReq, model: string, modelConfig?: Record<string, unknown>) => Record<string, unknown>;
  };
  responseAdapter: { fromProviderResponse: (res: unknown) => TRes };
  client: {
    call: (req: Record<string, unknown>, model: string, options?: ProviderCallOptions) => Promise<ProviderCallResult>;
  };
}

type GetAdapterSet<TReq, TRes> = (providerKind: string, providerConfig: ProviderConfig) => AdapterSet<TReq, TRes>;
type InternalResponse = InternalChatResponse | InternalEmbeddingResponse;

export async function callProvider<TReq, TRes extends InternalResponse>(
  ctx: RoutedModelHttpContext,
  request: TReq,
  getAdapterSet: GetAdapterSet<TReq, TRes>,
  label: string,
): Promise<void> {
  const providerLogger = getProviderLogger(ctx.route.providerKind);
  const { requestAdapter, responseAdapter, client } = getAdapterSet(ctx.route.providerKind, ctx.route.providerConfig);
  providerLogger.debug({ requestId: ctx.id }, `[dispatch] ${label.toLowerCase()} adapter initialized`);

  const rawProviderReqBody = requestAdapter.toProviderRequest(request, ctx.route.model, ctx.route.modelConfig);
  const providerReqBody = applyBodyOverrides(rawProviderReqBody, ctx.route.requestOverrides?.body);
  ctx.audit.providerRequest = { body: providerReqBody };
  providerLogger.debug({ requestId: ctx.id }, `[dispatch] ${label.toLowerCase()} request serialized`);

  ctx.timing.providerStart = Date.now();
  providerLogger.debug({ requestId: ctx.id, model: ctx.route.model }, '[dispatch] forwarding to upstream');
  const callOptions =
    ctx.route.timeoutMs !== undefined ||
    ctx.route.requestOverrides?.headers !== undefined ||
    ctx.route.modelConfig !== undefined
      ? {
          timeoutMs: ctx.route.timeoutMs,
          headers: ctx.route.requestOverrides?.headers,
          modelConfig: ctx.route.modelConfig,
        }
      : undefined;
  const result = await client.call(providerReqBody, ctx.route.model, callOptions);
  ctx.timing.providerEnd = Date.now();

  ctx.audit.providerRequest.headers = result.requestHeaders;
  ctx.audit.providerResponse = {
    statusCode: result.statusCode,
    headers: result.responseHeaders,
    body: result.body,
  };

  const providerDuration = ctx.timing.providerEnd - ctx.timing.providerStart;
  providerLogger.debug(
    { requestId: ctx.id, model: ctx.route.model, duration: `${providerDuration}ms` },
    '[dispatch] upstream responded',
  );

  ctx.response = responseAdapter.fromProviderResponse(result.body);
  providerLogger.debug({ requestId: ctx.id }, '[adapt] provider response → internal format');

  // DeepSeek 推理模型：缓存 reasoning_content 供后续多轮对话自动回填
  cacheReasoningFromResponse(ctx);
}

async function dispatchProvider<TReq, TRes extends InternalResponse>(
  ctx: RoutedModelHttpContext,
  request: TReq,
  getAdapterSet: GetAdapterSet<TReq, TRes>,
  label: string,
  executor: typeof callProvider,
): Promise<void> {
  const providerLogger = getProviderLogger(ctx.route.providerKind);
  try {
    await executor(ctx, request, getAdapterSet, label);
  } catch (error) {
    handleProviderError(error, ctx, label, providerLogger);
  }
}

// ========== 框架引擎: 公开入口 ==========

export async function dispatchChatProvider(
  ctx: RoutedModelHttpContext,
  chatRequest: InternalChatRequest,
  executor: typeof callProvider = callProvider,
): Promise<void> {
  const strippedRequest = stripUnsupportedChatParams(chatRequest, ctx.route.supportedParameters, ctx.id);
  await dispatchProvider<InternalChatRequest, InternalChatResponse>(
    ctx,
    strippedRequest,
    getProviderChatAdapterSet,
    'Chat',
    executor,
  );
}

export async function dispatchEmbeddingProvider(
  ctx: RoutedModelHttpContext,
  embeddingRequest: InternalEmbeddingRequest,
  executor: typeof callProvider = callProvider,
): Promise<void> {
  const strippedRequest = stripUnsupportedEmbeddingParams(embeddingRequest, ctx.route.supportedParameters, ctx.id);
  await dispatchProvider<InternalEmbeddingRequest, InternalEmbeddingResponse>(
    ctx,
    strippedRequest,
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
  ctx: RoutedModelHttpContext,
  chatRequest: InternalChatRequest,
  candidate: ResolvedRoute,
): Promise<StreamDispatchResult> {
  ctx.route = {
    ...ctx.route,
    model: candidate.actualModel,
    providerKind: candidate.providerKind,
    providerId: candidate.providerId,
    providerConfig: candidate.provider,
    modelConfig: candidate.modelConfig,
  };

  const providerLogger = getProviderLogger(ctx.route.providerKind);
  const { requestAdapter, streamResponseAdapter, client } = getProviderChatAdapterSet(
    ctx.route.providerKind,
    ctx.route.providerConfig,
  );
  providerLogger.debug({ requestId: ctx.id }, '[dispatch] stream adapter initialized');

  const strippedRequest = stripUnsupportedChatParams(chatRequest, candidate.supportedParameters, ctx.id);
  const rawProviderReqBody = requestAdapter.toProviderRequest(strippedRequest, ctx.route.model, candidate.modelConfig);
  const providerReqBody = applyBodyOverrides(rawProviderReqBody, candidate.requestOverrides?.body);
  ctx.audit.providerRequest = { body: providerReqBody };
  providerLogger.debug({ requestId: ctx.id }, '[dispatch] stream request serialized');

  ctx.timing.providerStart = Date.now();
  providerLogger.debug({ requestId: ctx.id, model: ctx.route.model }, '[dispatch] forwarding to upstream (stream)');

  const streamOptions =
    candidate.timeoutMs !== undefined ||
    candidate.requestOverrides?.headers !== undefined ||
    candidate.modelConfig !== undefined
      ? {
          timeoutMs: candidate.timeoutMs,
          headers: candidate.requestOverrides?.headers,
          modelConfig: candidate.modelConfig,
        }
      : undefined;
  const { response, requestHeaders: providerReqHeaders } = await client.callStream(
    providerReqBody,
    ctx.route.model,
    streamOptions,
  );

  ctx.audit.providerRequest.headers = providerReqHeaders;
  ctx.audit.providerResponse = {
    statusCode: response.status,
    headers: fetchHeadersToRecord(response.headers),
  };

  providerLogger.debug({ requestId: ctx.id, model: ctx.route.model }, '[dispatch] upstream stream connected');

  return { stream: createChunkGenerator(ctx, response, streamResponseAdapter, candidate.timeoutMs) };
}

export async function dispatchChatProviderStream(
  ctx: RoutedModelHttpContext,
  chatRequest: InternalChatRequest,
): Promise<StreamDispatchResult> {
  const candidates = configManager.resolveAllBackends(ctx.requestModel, ctx.route.capabilities);
  const candidate = candidates[0];

  if (!candidate) {
    throw new GatewayError(503, 'no_available_backend', `No available chat backends for model: ${ctx.requestModel}`);
  }

  try {
    return await tryStreamConnect(ctx, chatRequest, candidate);
  } catch (error) {
    handleProviderError(error, ctx, 'Chat Stream', getProviderLogger(candidate.providerKind));
  }
}
