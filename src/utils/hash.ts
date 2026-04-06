// src/utils/hash.ts — 密码哈希工具（crypto.scryptSync，零依赖）

import crypto from 'node:crypto';

const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

/**
 * 对明文密码进行 scrypt 哈希
 *
 * @returns 格式 "scrypt:<salt_hex>:<hash_hex>"
 */
export function hashPassword(plain: string): string {
  const salt = crypto.randomBytes(SALT_BYTES).toString('hex');
  const hash = crypto.scryptSync(plain, salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

/**
 * 验证明文密码与存储的哈希是否匹配
 */
export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    return false;
  }

  const salt = parts[1] ?? '';
  const storedHash = parts[2] ?? '';
  const hash = crypto.scryptSync(plain, salt, SCRYPT_KEYLEN).toString('hex');

  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(storedHash));
}
