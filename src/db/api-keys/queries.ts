// src/db/api-keys/queries.ts — API Key CRUD 查询

import crypto from 'node:crypto';
import { db } from '@/db/client';
import { generateShortId } from '@/db/id-generator';
import { buildUpdateSet, createLogger } from '@/utils';
import { invalidateApiKeyCache, lookupKeyHash } from './cache';
import type { ApiKeyCreateResult, ApiKeySummary } from './types';

const logger = createLogger('ApiKeys');

// ==================== 列字段常量 ====================

const SUMMARY_COLUMNS = 'id, name, key_prefix, is_active, expires_at, created_at, updated_at';

// ==================== 内部工具函数 ====================

/** 生成 API Key: lk- 前缀 + 48 位 hex (24 字节随机) */
function generateApiKey(): string {
  const random = crypto.randomBytes(24).toString('hex');
  return `lk-${random}`;
}

/** SHA-256 哈希 */
function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/** 提取前缀用于展示 (如 "lk-a3b4c5d6") */
function extractPrefix(key: string): string {
  return key.slice(0, 11);
}

// ==================== 服务函数 ====================

/**
 * 创建 API Key
 * @param name 描述性名称
 * @param expiresAt 可选过期时间
 * @returns 包含明文 key 的创建结果（仅此一次）
 */
export async function createApiKey(name: string, expiresAt?: string): Promise<ApiKeyCreateResult> {
  const key = generateApiKey();
  const hash = hashKey(key);
  const prefix = extractPrefix(key);
  const id = await generateShortId('api_keys');

  const result = await db.query<ApiKeySummary>(
    `INSERT INTO api_keys (id, name, key_hash, key_prefix, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${SUMMARY_COLUMNS}`,
    [id, name, hash, prefix, expiresAt ?? null],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error('Failed to create API key: no row returned');
  }
  logger.info({ id: row.id, name, prefix }, 'API key created');
  invalidateApiKeyCache();
  return { ...row, key };
}

/**
 * 列出所有 API Key（不含哈希）
 */
export async function listApiKeys(options?: {
  limit?: number;
  offset?: number;
  search?: string;
}): Promise<{ data: ApiKeySummary[]; total: number }> {
  const limitNum = options?.limit ?? 10;
  const offsetNum = options?.offset ?? 0;
  const search = options?.search;

  const conditions: string[] = [];
  const values: unknown[] = [];

  if (typeof search === 'string' && search.trim() !== '') {
    conditions.push(`(name ILIKE $${String(values.length + 1)} OR key_prefix ILIKE $${String(values.length + 1)})`);
    values.push(`%${search.trim()}%`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `
    SELECT ${SUMMARY_COLUMNS}, COUNT(*) OVER() AS full_count
    FROM api_keys
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT $${String(values.length + 1)} OFFSET $${String(values.length + 2)}
  `;

  values.push(limitNum, offsetNum);

  const result = await db.query<ApiKeySummary & { full_count: string }>(sql, values);
  const rows = result.rows;
  const firstRow = rows[0];
  const total = firstRow ? Number.parseInt(firstRow.full_count, 10) : 0;

  const data = rows.map((row) => {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    const { full_count: _full_count, ...rest } = row;
    return rest as ApiKeySummary;
  });

  return { data, total };
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
 * @returns 包含新明文 key 的结果
 */
export async function rotateApiKey(id: string): Promise<ApiKeyCreateResult | null> {
  const key = generateApiKey();
  const hash = hashKey(key);
  const prefix = extractPrefix(key);

  const result = await db.query<ApiKeySummary>(
    `UPDATE api_keys SET key_hash = $2, key_prefix = $3
     WHERE id = $1
     RETURNING ${SUMMARY_COLUMNS}`,
    [id, hash, prefix],
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
  return { ...row, key };
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
 * @returns 有效返回 true，无效返回 false
 */
export async function validateApiKey(rawKey: string): Promise<{ id: string; name: string } | null> {
  const hash = hashKey(rawKey);
  const cached = await lookupKeyHash(hash);

  if (!cached) {
    return null;
  }

  // 检查过期
  if (cached.expiresAt !== null && cached.expiresAt.getTime() < Date.now()) {
    return null;
  }

  return { id: cached.id, name: cached.name };
}
