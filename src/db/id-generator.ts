// src/db/id-generator.ts — 短哈希 ID 生成器
// 生成带实体前缀的唯一短 ID，查表保证唯一性

import crypto from 'node:crypto';
import { db } from './client';

/**
 * 允许使用短 ID 的表白名单及其对于前缀映射
 */
const PREFIX_MAP: Record<string, string> = {
  providers: 'prv',
  provider_models: 'pm',
  api_keys: 'ak',
  virtual_models: 'vm',
  users: 'usr',
  apps: 'app',
};

/**
 * 生成唯一短 ID（前缀 + 12 位 hex）
 *
 * 例如: app_1a2b3c4d5e6f
 * 随机生成 6 字节并转为 hex，查询目标表确认不重复，
 * 冲突时自动重试（实际冲突概率极低）。
 *
 * @param table 目标表名（必须在白名单中）
 * @returns 唯一的带前缀短 ID
 */
export async function generateShortId(table: string): Promise<string> {
  const prefix = PREFIX_MAP[table];
  if (prefix === undefined) {
    throw new Error(`Table "${table}" is not allowed for short ID generation`);
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    const id = `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
    const result = await db.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
    if (result.rowCount === 0) {
      return id;
    }
    // 极低概率冲突，重试
  }
}
