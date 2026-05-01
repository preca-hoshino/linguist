// src/providers/engine.ts — 提供商调用核心引擎与 HTTP 解析

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
import { createCachedLoggerFactory, GatewayError, logColors, parseSSEStream } from '@/utils';
import { fetchHeadersToRecord } from './http-utils';
import { getProviderChatAdapterSet, getProviderEmbeddingAdapterSet } from './index';
import type { ProviderChatStreamResponseAdapter } from './types';
import { cacheReasoningContent } from './deepseek/reasoning-cache';

// ========== 动态 Provider Logger ==========

/** 根据 providerKind 获取（或创建）对应的 Logger */
const getProviderLogger = createCachedLoggerFactory(
  {
    deepseek: { label: 'Provider:DeepSeek', color: logColors.bold + logColors.green },
    gemini: { label: 'Provider:Gemini', color: logColors.bold + logColors.yellow },
    volcengine: { label: 'Provider:VolcEngine', color: logColors.bold + logColors.magenta },
    copilot: { label: 'Provider:Copilot', color: logColors.bold + logColors.cyan },
  },
  'Provider',
  logColors.bold + logColors.white,
);

// ========== 错误消息脱敏 ==========

function sanitizeProviderError(detail: string): string {
  const stripped = detail.replace(/^\w[\w\s]* API returned \d+:\s*/i, '');
  return stripped.length > 0 ? stripped : 'Provider request failed';
}

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

// ========== 参数剥离 ==========

/**
 * 按后端声明的 supported_parameters 静默剥离 InternalChatRequest 中不支持的调优参数
 * 用于在适配器序列化前清理请求，避免不支持的参数被透传到提供商 API
 */
function stripUnsupportedChatParams(req: InternalChatRequest, supportedParameters: string[] = []): InternalChatRequest {
  // 若后端未声明任何 supported_parameters，不做过滤（向后兼容）
  if (supportedParameters.length === 0) {
    return req;
  }

  const FILTERABLE_PARAMS: ReadonlyArray<keyof InternalChatRequest> = [
    'temperature',
    'top_p',
    'top_k',
    'frequency_penalty',
    'presence_penalty',
    'stop',
  ] as const;

  const filtered: InternalChatRequest = { ...req };
  for (const field of FILTERABLE_PARAMS) {
    if (!supportedParameters.includes(field as string) && field in filtered) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (filtered as unknown as Record<string, unknown>)[field];
    }
  }
  return filtered;
}

/**
 * 应用 Body 重写规则（null = 删除字段，字符串 = 覆盖/追加）
 */
function applyBodyOverrides(
  body: Record<string, unknown>,
  overrides?: Record<string, string | null>,
): Record<string, unknown> {
  if (!overrides || Object.keys(overrides).length === 0) {
    return body;
  }
  const result = { ...body };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete result[key];
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ========== 框架引擎: 泛型内部实现 ==========

interface AdapterSet<TReq, TRes> {
  requestAdapter: {
    toProviderRequest: (req: TReq, model: string, modelConfig?: Record<string, unknown>) => Record<string, unknown>;
  };
  responseAdapter: { fromProviderResponse: (res: unknown) => TRes };
  client: {
    call: (
      req: Record<string, unknown>,
      model: string,
      options?: import('./types').ProviderCallOptions,
    ) => Promise<ProviderCallResult>;
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
    ctx.route.timeoutMs !== undefined || ctx.route.requestOverrides?.headers !== undefined || ctx.route.modelConfig !== undefined
      ? { timeoutMs: ctx.route.timeoutMs, headers: ctx.route.requestOverrides?.headers, modelConfig: ctx.route.modelConfig }
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
    const detail = error instanceof Error ? error.message : String(error);
    providerLogger.warn(
      { requestId: ctx.id, model: ctx.route.model, strategy: ctx.route.strategy, error: detail },
      `${ctx.route.strategy}: ${label.toLowerCase()} provider call failed`,
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

// ========== 框架引擎: 公开入口 ==========

export async function dispatchChatProvider(
  ctx: RoutedModelHttpContext,
  chatRequest: InternalChatRequest,
  executor: typeof callProvider = callProvider,
): Promise<void> {
  const strippedRequest = stripUnsupportedChatParams(chatRequest, ctx.route.supportedParameters);
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

  const strippedRequest = stripUnsupportedChatParams(chatRequest, candidate.supportedParameters);
  const rawProviderReqBody = requestAdapter.toProviderRequest(strippedRequest, ctx.route.model, candidate.modelConfig);
  const providerReqBody = applyBodyOverrides(rawProviderReqBody, candidate.requestOverrides?.body);
  ctx.audit.providerRequest = { body: providerReqBody };
  providerLogger.debug({ requestId: ctx.id }, '[dispatch] stream request serialized');

  ctx.timing.providerStart = Date.now();
  providerLogger.debug({ requestId: ctx.id, model: ctx.route.model }, '[dispatch] forwarding to upstream (stream)');

  const streamOptions =
    candidate.timeoutMs !== undefined || candidate.requestOverrides?.headers !== undefined || candidate.modelConfig !== undefined
      ? { timeoutMs: candidate.timeoutMs, headers: candidate.requestOverrides?.headers, modelConfig: candidate.modelConfig }
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

  return { stream: createChunkGenerator(ctx, response, streamResponseAdapter) };
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
  ctx: RoutedModelHttpContext,
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
