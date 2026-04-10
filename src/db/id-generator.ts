// src/db/id-generator.ts — 短哈希 ID 生成器
// 生成 8 位 hex 短 ID，查表保证唯一性

import crypto from 'node:crypto';
import { db } from './client';

/**
 * 允许使用短 ID 的表白名单（防止 SQL 注入）
 */
const ALLOWED_TABLES = new Set(['providers', 'provider_models', 'api_keys', 'virtual_models', 'users', 'apps']);

/**
 * 生成唯一短 ID（8 位 hex）
 *
 * 随机生成 4 字节并转为 hex，查询目标表确认不重复，
 * 冲突时自动重试（实际冲突概率极低）。
 *
 * @param table 目标表名（必须在白名单中）
 * @returns 唯一的 8 位 hex ID
 */
export async function generateShortId(table: string): Promise<string> {
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error(`Table "${table}" is not allowed for short ID generation`);
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    const id = crypto.randomBytes(4).toString('hex');
    const result = await db.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
    if (result.rowCount === 0) {
      return id;
    }
    // 极低概率冲突，重试
  }
}
