// src/db/apps/cache.ts — 应用（App）内存缓存
// 避免每次请求都查数据库，通过 LISTEN/NOTIFY 自动刷新

import { db } from '@/db/client';
import { createLogger } from '@/utils';

const logger = createLogger('Apps');

/** 缓存条目：appId → 应用元数据 */
export interface AppCacheEntry {
  id: string;
  name: string;
  isActive: boolean;
  allowedModelIds: string[];
}

/** appId → AppCacheEntry */
let appCache: Map<string, AppCacheEntry> | null = null;

/**
 * 加载所有活跃应用到内存缓存
 */
async function loadAppCache(): Promise<void> {
  const result = await db.query<{
    id: string;
    name: string;
    is_active: boolean;
    allowed_model_ids: string[];
  }>(`
    SELECT a.id, a.name, a.is_active,
           COALESCE(
             array_agg(DISTINCT aam.virtual_model_id) FILTER (WHERE aam.virtual_model_id IS NOT NULL),
             '{}'
           ) AS allowed_model_ids
    FROM apps a
    LEFT JOIN app_allowed_models aam ON aam.app_id = a.id
    WHERE a.is_active = true
    GROUP BY a.id
  `);

  const newCache = new Map<string, AppCacheEntry>();
  for (const row of result.rows) {
    newCache.set(row.id, {
      id: row.id,
      name: row.name,
      isActive: row.is_active,
      allowedModelIds: row.allowed_model_ids,
    });
  }

  appCache = newCache;
  logger.info({ count: newCache.size }, 'App cache loaded');
}

/**
 * 清除缓存（触发下次查找时重新加载）
 */
export function invalidateAppCache(): void {
  appCache = null;
  logger.debug('App cache invalidated');
}

/**
 * 从缓存中查找应用，懒加载
 */
export async function lookupApp(appId: string): Promise<AppCacheEntry | undefined> {
  if (appCache === null) {
    await loadAppCache();
  }
  return appCache?.get(appId);
}
