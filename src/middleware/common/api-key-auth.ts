// src/middleware/request/api-key-auth.ts — 用户侧 API Key 鉴权中间件

import { lookupAppByKey } from '@/db/apps';
import type { ModelHttpContext } from '@/types';
import { createLogger, GatewayError, logColors } from '@/utils';

const logger = createLogger('Middleware:ApiKeyAuth', logColors.bold + logColors.gray);

/**
 * API Key 鉴权中间件
 *
 * 从 ModelHttpContext.apiKey 读取用户提供的 API Key，
 * 根据单应用-单秘钥（api_key）机制，通过内存字典查找匹配的归属 App。
 * 不存在或验证失败时抛出 GatewayError（401）。
 *
 * 可通过环境变量 REQUIRE_API_KEY=false 关闭鉴权（开发环境）。
 */
export async function apiKeyAuth(ctx: ModelHttpContext): Promise<void> {
  // 环境变量控制：允许关闭鉴权（开发/测试环境）
  const requireApiKey = process.env.REQUIRE_API_KEY !== 'false';

  if (!requireApiKey) {
    logger.debug({ requestId: ctx.id }, 'API key auth skipped (REQUIRE_API_KEY=false)');
    return;
  }

  const rawKey = ctx.apiKey;

  if (rawKey === undefined || rawKey === '') {
    logger.warn({ requestId: ctx.id, ip: ctx.ip, format: ctx.userFormat }, 'Missing API key');
    const hint =
      ctx.userFormat === 'gemini'
        ? 'API key is required. Provide it via x-goog-api-key header or ?key= query parameter.'
        : 'API key is required. Provide it via Authorization: Bearer <key> header.';
    throw new GatewayError(401, 'unauthorized', hint);
  }

  const appInfo = await lookupAppByKey(rawKey);

  if (!appInfo?.isActive) {
    logger.warn({ requestId: ctx.id, ip: ctx.ip, keyPrefix: rawKey.slice(0, 11) }, 'Invalid or inactive API key');
    throw new GatewayError(401, 'invalid_api_key', 'Invalid or inactive API key');
  }

  // 写入 App 信息
  ctx.appId = appInfo.id;
  ctx.appName = appInfo.name;
  ctx.apiKeyName = appInfo.name; // In single key setup, the key identity resolves directly to the app's entity.

  logger.debug({ requestId: ctx.id, keyPrefix: rawKey.slice(0, 11), appId: ctx.appId }, 'API key auth passed');
}
