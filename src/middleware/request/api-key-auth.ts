// src/middleware/request/api-key-auth.ts — 用户侧 API Key 鉴权中间件

import type { GatewayContext } from '../../types';
import { GatewayError, createLogger, logColors } from '../../utils';
import { validateApiKey } from '../../db/api-keys';

const logger = createLogger('Middleware:ApiKeyAuth', logColors.bold + logColors.gray);

/**
 * API Key 鉴权中间件
 *
 * 从 GatewayContext.apiKey 读取用户提供的 API Key，
 * 验证其在数据库中是否存在且活跃（通过内存缓存加速）。
 *
 * 鉴权失败时抛出 GatewayError（401）。
 *
 * 可通过环境变量 REQUIRE_API_KEY=false 关闭鉴权（开发环境）。
 */
export async function apiKeyAuth(ctx: GatewayContext): Promise<void> {
  // 环境变量控制：允许关闭鉴权（开发/测试环境）
  const requireApiKey = process.env['REQUIRE_API_KEY'] !== 'false';

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

  const valid = await validateApiKey(rawKey);

  if (!valid) {
    logger.warn({ requestId: ctx.id, ip: ctx.ip, keyPrefix: rawKey.slice(0, 11) }, 'Invalid or expired API key');
    throw new GatewayError(401, 'invalid_api_key', 'Invalid or expired API key');
  }

  logger.debug({ requestId: ctx.id, keyPrefix: rawKey.slice(0, 11) }, 'API key auth passed');
}
