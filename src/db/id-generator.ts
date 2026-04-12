// src/db/id-generator.ts — 短哈希 ID 生成器
// 生成 8 位 hex 短 ID，查表保证唯一性

import crypto from 'node:crypto';
import { db } from './client';

/**
 * 允许使用短 ID 的表白名单（防止 SQL 注入）
 */
const ALLOWED_TABLES = new Set(['providers', 'provider_models', 'api_keys', 'virtual_models', 'users', 'apps']);

/**
 * 表对应的 Stripe 风格 ID 前缀映射
 */
const TABLE_PREFIXES: Record<string, string> = {
  users: 'usr',
  providers: 'pvd',
  provider_models: 'pm',
  virtual_models: 'vm',
  apps: 'app',
  api_keys: 'key',
};

/**
 * 生成带有业务前缀的唯一短 ID
 *
 * 生成 8 字节并转为 hex（16 字符），配合前缀长约 20 字符。
 * 冲突时自动重试（实际冲突概率极低）。
 *
 * @param table 目标表名（必须在白名单中）
 * @returns 唯一的 8 位 hex ID
 */
export async function generateShortId(table: string): Promise<string> {
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error(`Table "${table}" is not allowed for short ID generation`);
  }

  const prefix = TABLE_PREFIXES[table] ?? 'unk';

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    const hash = crypto.randomBytes(3).toString('hex');
    const id = `${prefix}_${hash}`;
    const result = await db.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
    if (result.rowCount === 0) {
      return id;
    }
    // 极低概率冲突，重试
  }
}
