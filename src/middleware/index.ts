// src/middleware/index.ts — 中间件链执行器

import type { ModelHttpContext } from '@/types';
import { createLogger, logColors } from '@/utils';
import type { Middleware } from './types';

const logger = createLogger('Middleware', logColors.bold + logColors.gray);

export { apiKeyAuth } from './common';
export { allowedModelCheck, normalizeChatToolCallIds, rateLimit } from './model/http/request';
export { normalizeResponseChatToolCallIds, tokenAccounting } from './model/http/response';
export type { Middleware } from './types';

/**
 * 顺序执行中间件链
 * 每个中间件依次对 ModelHttpContext 进行读写操作
 */
export async function applyMiddlewares(ctx: ModelHttpContext, middlewares: Middleware[]): Promise<void> {
  if (middlewares.length === 0) {
    return;
  }
  logger.debug({ requestId: ctx.id, count: middlewares.length }, '[auth] executing middleware chain');
  for (const mw of middlewares) {
    await mw(ctx);
  }
  logger.debug({ requestId: ctx.id }, '[auth] middleware chain passed');
}
