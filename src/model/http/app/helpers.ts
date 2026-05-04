// src/app/helpers.ts — 请求处理辅助函数

import type { ModelHttpContext } from '@/types';
import type { Logger } from '@/utils';

// ========== 生命周期收尾 Helpers ==========

/**
 * 成功收尾：记录 timing 并打印成功日志
 * 由调用方负责之后执行 markCompleted(ctx)
 */
export function finalizeSuccess(ctx: ModelHttpContext, label: string, logger: Logger): void {
  ctx.timing.end = Date.now();
  const totalDuration = ctx.timing.end - ctx.timing.start;
  const providerDuration =
    ctx.timing.providerStart !== undefined && ctx.timing.providerEnd !== undefined
      ? ctx.timing.providerEnd - ctx.timing.providerStart
      : undefined;
  const gatewayOverhead = providerDuration === undefined ? undefined : totalDuration - providerDuration;
  logger.info(
    {
      requestId: ctx.id,
      model: ctx.requestModel,
      routedModel: ctx.route?.model,
      provider: ctx.route?.providerKind,
      endpoint: ctx.http.path,
      ...(ctx.stream === true ? { stream: true } : {}),
      totalDuration: `${totalDuration}ms`,
      providerDuration: providerDuration === undefined ? 'N/A' : `${String(providerDuration)}ms`,
      gatewayOverhead: gatewayOverhead === undefined ? 'N/A' : `${String(gatewayOverhead)}ms`,
    },
    `${label} request fulfilled`,
  );
}

/**
 * 失败收尾：写入 ctx.error、记录 timing 并打印失败日志
 * 由调用方负责之后执行 markError(ctx, err)
 */
export function finalizeError(ctx: ModelHttpContext, err: unknown, label: string, logger: Logger): void {
  ctx.error = err instanceof Error ? err.message : String(err);
  ctx.timing.end = Date.now();
  const totalDuration = ctx.timing.end - ctx.timing.start;
  logger.warn(
    {
      requestId: ctx.id,
      model: ctx.requestModel,
      endpoint: ctx.http.path,
      ...(ctx.stream === true ? { stream: true } : {}),
      error: ctx.error,
      duration: `${totalDuration}ms`,
    },
    `${label} request failed`,
  );
}
