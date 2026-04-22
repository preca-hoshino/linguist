// src/db/id-generator.ts — 短哈希 ID 生成器
// 生成带实体前缀的唯一短 ID（前缀 + '_' + 6位hex），查表保证唯一性

import crypto from 'node:crypto';
import { db } from './client';

/**
 * 允许使用短 ID 的表白名单及其对于前缀映射
 */
const ALLOWED_TABLES = new Set([
  'model_providers',
  'model_provider_models',
  'virtual_models',
  'users',
  'apps',
  'mcp_providers',
  'virtual_mcps',
]);

/**
 * 表对应的 Stripe 风格 ID 前缀映射
 */
const TABLE_PREFIXES: Record<string, string> = {
  users: 'usr',
  apps: 'app',
  model_providers: 'model_pvd',
  model_provider_models: 'model_p',
  virtual_models: 'model_v',
  mcp_providers: 'mcp_p',
  virtual_mcps: 'mcp_v',
};

/**
 * 生成带有业务前缀的唯一短 ID
 *
 * 生成 3 字节并转为 hex（6 字符），配合前缀组成形如 `usr_e05add` 的短 ID。
 * 冲突时自动重试（实际冲突概率极低）。
 *
 * @param table 目标表名（必须在白名单中）
 * @returns 唯一的带前缀短 ID
 */
export async function generateShortId(table: string): Promise<string> {
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error(`Table "${table}" is not allowed for short ID generation`);
  }

  const prefix = TABLE_PREFIXES[table] ?? 'unk';

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    const hexSegment = crypto.randomBytes(3).toString('hex');
    const id = `${prefix}_${hexSegment}`;
    const result = await db.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
    if (result.rowCount === 0) {
      return id;
    }
    // 极低概率冲突，重试
  }
}
