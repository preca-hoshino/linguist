// src/db/apps/cache.ts — 应用（App）内存缓存
// 避免每次请求都查数据库，通过 LISTEN/NOTIFY 自动刷新

import { db } from '@/db/client';
import { createLogger } from '@/utils';

const logger = createLogger('Apps');

/** 缓存条目：应用元数据 */
export interface AppCacheEntry {
  id: string;
  name: string;
  isActive: boolean;
  apiKey: string;
  allowedModelIds: string[];
}

let appCacheById: Map<string, AppCacheEntry> | null = null;
let appCacheByKey: Map<string, AppCacheEntry> | null = null;

/**
 * 加载所有活跃应用到内存缓存
 */
async function loadAppCache(): Promise<void> {
  const result = await db.query<{
    id: string;
    name: string;
    is_active: boolean;
    api_key: string;
    allowed_model_ids: string[];
  }>(`
    SELECT a.id, a.name, a.is_active, a.api_key,
           COALESCE(
             array_agg(DISTINCT aam.virtual_model_id) FILTER (WHERE aam.virtual_model_id IS NOT NULL),
             '{}'
           ) AS allowed_model_ids
    FROM apps a
    LEFT JOIN app_allowed_models aam ON aam.app_id = a.id
    WHERE a.is_active = true
    GROUP BY a.id, a.name, a.is_active, a.api_key
  `);

  const newCacheById = new Map<string, AppCacheEntry>();
  const newCacheByKey = new Map<string, AppCacheEntry>();

  for (const row of result.rows) {
    const entry = {
      id: row.id,
      name: row.name,
      isActive: row.is_active,
      apiKey: row.api_key,
      allowedModelIds: row.allowed_model_ids,
    };
    newCacheById.set(row.id, entry);
    // 同时也存入以 apiKey 为键的 map 中，用于鉴权极速匹配
    newCacheByKey.set(row.api_key, entry);
  }

  appCacheById = newCacheById;
  appCacheByKey = newCacheByKey;
  logger.info({ count: newCacheById.size }, 'App cache loaded');
}

/**
 * 清除缓存（触发下次查找时重新加载）
 */
export function invalidateAppCache(): void {
  appCacheById = null;
  appCacheByKey = null;
  logger.debug('App cache invalidated');
}

/**
 * 从缓存中查找应用 (by id)
 */
export async function lookupApp(appId: string): Promise<AppCacheEntry | undefined> {
  if (appCacheById === null) {
    await loadAppCache();
  }
  return appCacheById?.get(appId);
}

/**
 * 从缓存中查找应用 (by API Key)
 */
export async function lookupAppByKey(apiKey: string): Promise<AppCacheEntry | undefined> {
  if (appCacheByKey === null) {
    await loadAppCache();
  }
  return appCacheByKey?.get(apiKey);
}
