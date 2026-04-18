// src/api/auth-helper.ts — 端点级 API Key 鉴权辅助
//
// 为非核心流程端点（如 GET /v1/models）提供鉴权，
// 复用与 apiKeyAuth 中间件完全一致的逻辑：环境变量开关 + 哈希校验。

import type { Request } from 'express';
import { lookupAppByKey, type AppCacheEntry } from '@/db/apps';
import { GatewayError } from '@/utils';

/**
 * 从请求中提取并校验 API Key（非核心流程端点使用）
 *
 * 逻辑与 middleware/request/api-key-auth.ts 保持一致：
 * - REQUIRE_API_KEY=false 时跳过
 * - 缺失 key 或校验失败时抛出 GatewayError
 *
 * @param req Express 请求对象
 * @param extractKey API Key 提取函数
 * @param missingKeyMessage 自定义缺失 API Key 时的报错文案
 */
export async function validateApiKeyFromRequest(
  req: Request,
  extractKey: (req: Request) => string | undefined,
  missingKeyMessage = 'API key is required. Provide it via Authorization: Bearer <key> header.',
): Promise<AppCacheEntry | undefined> {
  const requireApiKey = process.env.REQUIRE_API_KEY !== 'false';
  if (!requireApiKey) {
    return undefined;
  }

  const apiKey = extractKey(req);
  if (apiKey === undefined || apiKey === '') {
    throw new GatewayError(401, 'unauthorized', missingKeyMessage);
  }

  const appInfo = await lookupAppByKey(apiKey);
  if (!appInfo?.isActive) {
    throw new GatewayError(401, 'invalid_api_key', 'Invalid or expired API key');
  }

  return appInfo;
}
