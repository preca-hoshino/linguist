// src/app/process.ts — 核心请求处理流程

import type { Request, Response } from 'express';
import { getApiKeyExtractor, getFormatLogger } from '@/api';
import { markCompleted, markError, markProcessing } from '@/db';
import type { Middleware } from '@/middleware';
import {
  apiKeyAuth,
  allowedModelCheck,
  applyMiddlewares,
  normalizeChatToolCallIds,
  normalizeResponseChatToolCallIds,
  rateLimit,
  tokenAccounting,
} from '@/middleware';
import { dispatchChatProvider, dispatchEmbeddingProvider } from '@/model/http/providers/engine';
import { assertRouted, route } from '@/model/http/router';
import type { ModelHttpContext, HttpHeaders, InternalChatRequest, InternalEmbeddingRequest } from '@/types';
import { buildErrorResponseBody, getUserChatAdapter, getUserEmbeddingAdapter, handleError } from '@/model/http/users';
import { GatewayError } from '@/utils';
import { v4 as uuidv4 } from '@/utils/uuid';
import { expressHeadersToRecord, finalizeError, finalizeSuccess, sanitizeHeaders } from './helpers';
import { processStreamSend } from './stream';

// 中间件列表
const requestMiddlewares: Middleware[] = [apiKeyAuth, allowedModelCheck, normalizeChatToolCallIds];
const postRouteMiddlewares: Middleware[] = [rateLimit];
const responseMiddlewares: Middleware[] = [normalizeResponseChatToolCallIds, tokenAccounting];

// ========== 公开入口（薄包装） ==========

/**
 * 聊天请求核心处理流程
 * 各 API 格式模块（src/api/*）调用此函数，传入格式标识和 model 名称。
 * @param options.stream — 可选，强制覆盖流式标记（用于 Gemini 等由 URL 端点决定流式的格式）
 */
export async function processChatCompletion(
  req: Request,
  res: Response,
  userFormat: string,
  modelName: string,
  options?: { stream?: boolean },
): Promise<void> {
  await processRequest(req, res, userFormat, modelName, 'chat', options);
}

/**
 * 嵌入请求核心处理流程
 * 各 API 格式模块（src/api/*）调用此函数，传入格式标识和 model 名称。
 */
export async function processEmbedding(
  req: Request,
  res: Response,
  userFormat: string,
  modelName: string,
): Promise<void> {
  await processRequest(req, res, userFormat, modelName, 'embedding');
}

// ========== 统一核心处理流程 ==========

/**
 * 统一请求处理流程（聊天 + 嵌入共享同一生命周期骨架）
 *
 * 生命周期：
 *   1. 创建最小 ctx（确保 catch 块始终有 requestId 可用）
 *   2. 提取 API Key → 写入 ctx（在 try 内，异常可被追踪）
 *   3. 校验请求体 & model 字段
 *   4. 用户请求适配 → ctx.request（内部统一格式）
 *   5. 请求中间件链（含鉴权）
 *   6. 路由 → assertRouted，INSERT 日志行（processing）
 *   7. 调度 + 发送（唯一因 stream/type 分叉的阶段）
 *      └─ 非流式：dispatch → 响应中间件 → 适配 → sendJSON
 *      └─ 流式：processStreamSend（内部建连、SSE 传输）
 *   success: finalizeSuccess → markCompleted
 *   catch:   finalizeError → handleError / res.end → markError
 */
async function processRequest(
  req: Request,
  res: Response,
  userFormat: string,
  modelName: string,
  expectedModelType: 'chat' | 'embedding',
  options?: { stream?: boolean },
): Promise<void> {
  const isChat = expectedModelType === 'chat';
  const label = isChat ? 'Chat completion' : 'Embedding';
  const logger = getFormatLogger(userFormat);

  // 1. 创建最小 ctx —— catch 块始终可访问 ctx.id / ctx.http.path 用于日志和 markError
  const ctx: ModelHttpContext = {
    id: uuidv4(),
    ip: req.ip ?? req.socket.remoteAddress ?? 'unknown',
    http: {
      method: req.method.toUpperCase(),
      path: req.path,
      userAgent: req.headers['user-agent'],
    },
    userFormat,
    requestModel: modelName,
    audit: {
      userRequest: {
        headers: sanitizeHeaders(req.headers as HttpHeaders),
        body: req.body as Record<string, unknown>,
      },
    },
    timing: { start: Date.now() },
  };

  logger.info({ requestId: ctx.id, model: modelName, endpoint: req.path, ip: ctx.ip }, `${label} request received`);

  try {
    // 2. 提取 API Key（在 try 内，异常携带 requestId 可被追踪）
    const rawApiKey = getApiKeyExtractor(userFormat)(req);
    ctx.apiKey = rawApiKey;

    // 3. 校验 model（请求体由 express.json() 中间件保证为对象）
    if (ctx.requestModel === '') {
      throw new GatewayError(400, 'missing_model', 'Request must include a model identifier');
    }

    // 4. 用户请求适配 → ctx.request（内部统一格式，不含 model）
    const userAdapter = isChat ? getUserChatAdapter(userFormat) : getUserEmbeddingAdapter(userFormat);
    ctx.request = userAdapter.request.toInternal(req.body as Record<string, unknown>);

    ctx.timing.requestAdapted = Date.now();
    logger.debug({ requestId: ctx.id }, '[parse] user request → internal format');

    // 记录流式标记
    if (isChat) {
      // 若调用方通过 options.stream 强制覆盖（如 Gemini streamGenerateContent 端点），使用覆盖值
      if (options?.stream !== undefined) {
        (ctx.request as InternalChatRequest).stream = options.stream;
      }
      ctx.stream = (ctx.request as InternalChatRequest).stream;
    }

    // 5. 请求中间件链（含鉴权）
    await applyMiddlewares(ctx, requestMiddlewares);
    ctx.timing.middlewareDone = Date.now();

    // 6. 路由 → 校验路由字段完整性 → 路由后中间件（流控检查）→ INSERT 日志行
    route(ctx, expectedModelType);
    assertRouted(ctx);
    await applyMiddlewares(ctx, postRouteMiddlewares);
    void markProcessing(ctx);

    // 7. 调度 + 发送（流式 vs 非流式唯一分叉点）
    const isStream = isChat && (ctx.request as InternalChatRequest).stream;
    if (isStream) {
      await processStreamSend(ctx, res, responseMiddlewares);
    } else {
      await (isChat
        ? dispatchChatProvider(ctx, ctx.request as InternalChatRequest)
        : dispatchEmbeddingProvider(ctx, ctx.request as InternalEmbeddingRequest));
      await applyMiddlewares(ctx, responseMiddlewares);
      ctx.timing.responseMiddlewareDone = Date.now();
      const userResBody = userAdapter.response.fromInternal(ctx);
      ctx.timing.responseAdapted = Date.now();
      logger.debug({ requestId: ctx.id }, '[adapt] internal response → user format');
      res.json(userResBody);
      // 记录用户响应审计数据（响应头 + 响应体）
      ctx.audit.userResponse = {
        statusCode: res.statusCode,
        headers: expressHeadersToRecord(res.getHeaders()),
        body: userResBody,
      };
    }

    finalizeSuccess(ctx, label, logger);
    void markCompleted(ctx);
  } catch (error) {
    finalizeError(ctx, error, label, logger);
    if (res.headersSent) {
      res.end(); // 流式传输中途出错，只能关闭连接
    } else {
      handleError(error, res, userFormat);
    }
    // 记录错误响应审计数据（与 handleError 构建完全一致的响应体）
    const errorPayload = buildErrorResponseBody(error, userFormat);
    ctx.audit.userResponse = {
      statusCode: res.statusCode,
      headers: expressHeadersToRecord(res.getHeaders()),
      body: errorPayload.body,
    };
    void markError(ctx, error);
  }
}
