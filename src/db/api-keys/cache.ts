// src/db/api-keys/cache.ts — API Key 内存缓存
// 避免每次请求都查数据库，通过 LISTEN/NOTIFY 自动刷新

import { db } from '@/db/client';
import { createLogger } from '@/utils';

const logger = createLogger('ApiKeys');

/**
 * API Key 缓存 (key_value → { id, name, appId, expiresAt })
 */
let keyCache: Map<string, { id: string; name: string; appId: string; expiresAt: Date | null }> | null = null;

/**
 * 加载所有活跃 API Key 到内存缓存
 * 仅加载所属 App 也活跃的 Key
 */
async function loadApiKeyCache(): Promise<void> {
  const result = await db.query<{
    id: string;
    name: string;
    key_value: string;
    app_id: string;
    expires_at: string | null;
  }>(
    `SELECT ak.id, ak.name, ak.key_value, ak.app_id, ak.expires_at
     FROM api_keys ak
     JOIN apps a ON ak.app_id = a.id
     WHERE ak.is_active = true AND a.is_active = true`,
  );

  const newCache = new Map<string, { id: string; name: string; appId: string; expiresAt: Date | null }>();
  for (const row of result.rows) {
    newCache.set(row.key_value, {
      id: row.id,
      name: row.name,
      appId: row.app_id,
      expiresAt: row.expires_at === null ? null : new Date(row.expires_at),
    });
  }

  keyCache = newCache;
  logger.info({ count: newCache.size }, 'API key cache loaded');
}

/**
 * 清除缓存（触发下次验证时重新加载）
 */
export function invalidateApiKeyCache(): void {
  keyCache = null;
  logger.debug('API key cache invalidated');
}

/**
 * 从缓存中查找 key_value（明文完整 Key），懒加载
 */
export async function lookupKey(
  keyValue: string,
): Promise<{ id: string; name: string; appId: string; expiresAt: Date | null } | undefined> {
  if (keyCache === null) {
    await loadApiKeyCache();
  }
  return keyCache?.get(keyValue);
}
