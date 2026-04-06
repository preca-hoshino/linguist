// src/utils/jwt.ts — HS256 JWT 签发与验证（零依赖，仅用 Node crypto）

import crypto from 'node:crypto';

/**
 * JWT payload：精简为最小必要字段（sub + 时间戳）
 * 用户信息通过 GET /api/me 实时获取，不嵌入 Token
 */
interface JwtPayload {
  sub: string; // userId
  iat: number;
  exp: number;
}

/** 默认有效期：24 小时（秒） */
const DEFAULT_EXPIRES_IN = 86_400;

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64url');
}

function base64urlDecode(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8');
}

/**
 * 签发 JWT token
 *
 * @param payload 业务数据（仅含 sub）
 * @param secret  HS256 密钥
 * @param expiresIn 有效期（秒），默认 86400
 */
export function signToken(
  payload: Omit<JwtPayload, 'iat' | 'exp'>,
  secret: string,
  expiresIn: number = DEFAULT_EXPIRES_IN,
): string {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: JwtPayload = { ...payload, iat: now, exp: now + expiresIn };

  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(fullPayload));
  const signature = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');

  return `${header}.${body}.${signature}`;
}

/**
 * 验证并解码 JWT token
 *
 * @returns 解码后的 payload，验证失败或过期返回 null
 */
export function verifyToken(token: string, secret: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }

  const [header, body, signature] = parts as [string, string, string];
  const expected = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return null;
  }

  try {
    const payload = JSON.parse(base64urlDecode(body)) as JwtPayload;
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp <= now) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
