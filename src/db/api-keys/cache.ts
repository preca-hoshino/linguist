// src/db/api-keys/cache.ts — API Key 内存缓存
// 避免每次请求都查数据库，通过 LISTEN/NOTIFY 自动刷新

import { db } from '../client';
import { createLogger } from '../../utils';

const logger = createLogger('ApiKeys');

/**
 * API Key 哈希缓存 (key_hash → { id, expiresAt })
 */
let keyCache: Map<string, { id: string; expiresAt: Date | null }> | null = null;

/**
 * 加载所有活跃 API Key 哈希到内存缓存
 */
export async function loadApiKeyCache(): Promise<void> {
  const result = await db.query<{ key_hash: string; id: string; expires_at: string | null }>(
    'SELECT id, key_hash, expires_at FROM api_keys WHERE is_active = true',
  );

  const newCache = new Map<string, { id: string; expiresAt: Date | null }>();
  for (const row of result.rows) {
    newCache.set(row.key_hash, {
      id: row.id,
      expiresAt: row.expires_at !== null ? new Date(row.expires_at) : null,
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
 * 从缓存中查找 key_hash，懒加载
 */
export async function lookupKeyHash(hash: string): Promise<{ id: string; expiresAt: Date | null } | undefined> {
  if (keyCache === null) {
    await loadApiKeyCache();
  }
  return keyCache?.get(hash);
}
