// src/db/api-keys/queries.ts — API Key CRUD 查询
// 明文存储，无 hash 计算

import crypto from 'node:crypto';
import { db } from '@/db/client';
import { generateShortId } from '@/db/id-generator';
import { buildUpdateSet, createLogger } from '@/utils';
import { invalidateApiKeyCache, lookupKey } from './cache';
import type { ApiKeySummary } from './types';

const logger = createLogger('ApiKeys');

// ==================== 列字段常量 ====================

const SUMMARY_COLUMNS = 'id, app_id, name, key_value, key_prefix, is_active, expires_at, created_at, updated_at';

// ==================== 内部工具函数 ====================

/** 生成 API Key: lk- 前缀 + 48 位 hex (24 字节随机) */
function generateApiKey(): string {
  const random = crypto.randomBytes(24).toString('hex');
  return `lk-${random}`;
}

/** 提取前缀用于展示 (如 "lk-a3b4c5d6") */
function extractPrefix(key: string): string {
  return key.slice(0, 11);
}

// ==================== 服务函数 ====================

/**
 * 创建 API Key（隶属于指定 App）
 * @param appId 所属应用 ID
 * @param name 描述性名称
 * @param expiresAt 可选过期时间
 * @returns 包含完整 key_value 的结果（明文永久可查）
 */
export async function createApiKey(appId: string, name: string, expiresAt?: string): Promise<ApiKeySummary> {
  const key = generateApiKey();
  const prefix = extractPrefix(key);
  const id = await generateShortId('api_keys');

  const result = await db.query<ApiKeySummary>(
    `INSERT INTO api_keys (id, app_id, name, key_value, key_prefix, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${SUMMARY_COLUMNS}`,
    [id, appId, name, key, prefix, expiresAt ?? null],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error('Failed to create API key: no row returned');
  }
  logger.info({ id: row.id, name, prefix }, 'API key created');
  invalidateApiKeyCache();
  return row;
}

/**
 * 列出 API Key（支持按 appId 筛选）
 */
export async function listApiKeys(options?: {
  appId?: string;
  limit?: number;
  starting_after?: string;
  search?: string;
}): Promise<{ data: ApiKeySummary[]; has_more: boolean; total: number }> {
  const limitNum = typeof options?.limit === 'number' ? Math.min(Math.max(options.limit, 1), 100) : 10;
  const startingAfterStr = options?.starting_after;
  const search = options?.search;
  const appId = options?.appId;

  const conditions: string[] = [];
  const values: unknown[] = [];

  if (typeof appId === 'string' && appId.trim() !== '') {
    conditions.push(`app_id = $${String(values.length + 1)}`);
    values.push(appId);
  }

  if (typeof search === 'string' && search.trim() !== '') {
    conditions.push(`(name ILIKE $${String(values.length + 1)} OR key_prefix ILIKE $${String(values.length + 1)})`);
    values.push(`%${search.trim()}%`);
  }

  const baseWhereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countSql = `SELECT COUNT(*) AS total FROM api_keys ${baseWhereClause}`;
  const countResult = await db.query(countSql, values);
  const total = Number.parseInt((countResult.rows[0] as { total: string } | undefined)?.total ?? '0', 10);

  if (typeof startingAfterStr === 'string' && startingAfterStr.trim() !== '') {
    conditions.push(`created_at < (SELECT created_at FROM api_keys WHERE id = $${String(values.length + 1)})`);
    values.push(startingAfterStr);
  }

  const dataWhereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `
    SELECT ${SUMMARY_COLUMNS}
    FROM api_keys
    ${dataWhereClause}
    ORDER BY created_at DESC
    LIMIT $${String(values.length + 1)}
  `;

  values.push(limitNum + 1);

  const result = await db.query<ApiKeySummary>(sql, values);
  const dataRows = result.rows.length > limitNum ? result.rows.slice(0, limitNum) : result.rows;
  const hasMore = result.rows.length > limitNum;

  return { data: dataRows, has_more: hasMore, total };
}

/**
 * 按 ID 查询 API Key 详情
 */
export async function getApiKeyById(id: string): Promise<ApiKeySummary | null> {
  const result = await db.query<ApiKeySummary>(`SELECT ${SUMMARY_COLUMNS} FROM api_keys WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

/**
 * 更新 API Key 信息（名称、启用状态、过期时间）
 */
export async function updateApiKey(
  id: string,
  updates: { name?: string | undefined; is_active?: boolean | undefined; expires_at?: string | null | undefined },
): Promise<ApiKeySummary | null> {
  const update = buildUpdateSet({
    name: updates.name,
    is_active: updates.is_active,
    expires_at: updates.expires_at,
  });

  if (!update) {
    return null;
  }

  update.values.push(id);
  const result = await db.query<ApiKeySummary>(
    `UPDATE api_keys SET ${update.setClause} WHERE id = $${String(update.nextIdx)}
     RETURNING ${SUMMARY_COLUMNS}`,
    update.values,
  );

  if (result.rowCount === 0) {
    return null;
  }

  invalidateApiKeyCache();
  logger.info({ id }, 'API key updated');
  const updated = result.rows[0];
  if (!updated) {
    return null;
  }
  return updated;
}

/**
 * 轮换 API Key（重新生成密钥，保留元数据）
 * @returns 含新 key_value 的结果（明文永久可查）
 */
export async function rotateApiKey(id: string): Promise<ApiKeySummary | null> {
  const key = generateApiKey();
  const prefix = extractPrefix(key);

  const result = await db.query<ApiKeySummary>(
    `UPDATE api_keys SET key_value = $2, key_prefix = $3
     WHERE id = $1
     RETURNING ${SUMMARY_COLUMNS}`,
    [id, key, prefix],
  );

  if (result.rowCount === 0) {
    return null;
  }

  invalidateApiKeyCache();
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  logger.info({ id, prefix }, 'API key rotated');
  return row;
}

/**
 * 删除 API Key
 * @returns 是否删除成功
 */
export async function deleteApiKey(id: string): Promise<boolean> {
  const result = await db.query('DELETE FROM api_keys WHERE id = $1 RETURNING id', [id]);

  if (result.rowCount === 0) {
    return false;
  }

  invalidateApiKeyCache();
  logger.info({ id }, 'API key deleted');
  return true;
}

/**
 * 验证 API Key 是否有效
 * 先查内存缓存，缓存未命中则加载
 * @param rawKey 明文 API Key
 * @returns 有效返回 { id, name, appId }，无效返回 null
 */
export async function validateApiKey(rawKey: string): Promise<{ id: string; name: string; appId: string } | null> {
  const cached = await lookupKey(rawKey);

  if (!cached) {
    return null;
  }

  // 检查过期
  if (cached.expiresAt !== null && cached.expiresAt.getTime() < Date.now()) {
    return null;
  }

  return { id: cached.id, name: cached.name, appId: cached.appId };
}
