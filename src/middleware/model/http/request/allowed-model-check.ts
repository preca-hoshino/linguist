// src/middleware/model/http/request/allowed-model-check.ts — App 模型白名单校验中间件
//
// 在 apiKeyAuth 之后执行（ctx.appId 已由 apiKeyAuth 写入）。
// 通过 configManager.getVirtualModelConfig(name) 获取虚拟模型内部 ID，
// 再与 AppCacheEntry.allowedModelIds（存内部 ID）做比对，实现 name → ID 的正确匹配。
//
// 心智模型：
// - 外部调用（用户）传 name（如 "global-gpt-4o"）
// - 内部白名单（DB/Cache）存内部 ID（如 "model_v_xxxxxx"）
// - 本中间件负责转换层，确保两侧正确对齐

import { configManager } from '@/config';
import { lookupApp } from '@/db/apps';
import type { ModelHttpContext } from '@/types';
import { createLogger, GatewayError, logColors } from '@/utils';

const logger = createLogger('Middleware:AllowedModelCheck', logColors.bold + logColors.gray);

/**
 * App 模型白名单校验中间件
 *
 * 执行时机：apiKeyAuth 之后（ctx.appId 已填充）、路由解析之前
 *
 * 职责：
 * 1. 若 App 无模型白名单限制（allowedModelIds 为空数组），则放行所有模型
 * 2. 若设有白名单，将请求模型名字转换为内部 ID 后比对，不匹配则 403
 */
export async function allowedModelCheck(ctx: ModelHttpContext): Promise<void> {
  // 未鉴权模式（REQUIRE_API_KEY=false）跳过，ctx.appId 为 undefined
  if (ctx.appId === undefined || ctx.appId === '') {
    return;
  }

  const app = await lookupApp(ctx.appId);
  if (!app) {
    // 极端竞态：App 已在鉴权后被删除，防御性处理
    logger.warn({ requestId: ctx.id, appId: ctx.appId }, 'App not found after successful auth');
    return;
  }

  // 未设白名单则放行（空数组视为不限制）
  if (app.allowedModelIds.length === 0) {
    return;
  }

  // 将请求模型名字转换为内部 ID（name → VirtualModelConfig.id）
  const vmConfig = configManager.getVirtualModelConfig(ctx.requestModel);
  if (!vmConfig) {
    // 模型不存在，由后续 route() 抛 404，此处不重复处理
    return;
  }

  if (!app.allowedModelIds.includes(vmConfig.id)) {
    logger.warn(
      { requestId: ctx.id, appId: ctx.appId, model: ctx.requestModel, vmId: vmConfig.id },
      'Model not in App allowed list',
    );
    throw new GatewayError(403, 'forbidden', `App '${app.name}' is not allowed to access model: ${ctx.requestModel}`);
  }

  logger.debug({ requestId: ctx.id, appId: ctx.appId, model: ctx.requestModel }, 'Model access allowed');
}
