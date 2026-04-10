// src/db/users/repository.ts — 用户数据访问层

import { db, generateShortId } from '@/db';
import { hashPassword } from '@/utils/hash';

/** 数据库行类型（不含 password_hash） */
interface UserRow {
  id: string;
  username: string;
  email: string;
  avatar_data: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

/** 含密码哈希的完整行（仅内部查询用） */
interface UserRowFull extends UserRow {
  password_hash: string;
}

/** 安全字段列表（排除 password_hash） */
const SAFE_COLUMNS = 'id, username, email, avatar_data, is_active, created_at, updated_at';

/**
 * 按邮箱查找用户（登录用，返回含 password_hash）
 */
export async function findByEmail(email: string): Promise<UserRowFull | null> {
  const result = await db.query<UserRowFull>(
    'SELECT id, username, email, password_hash, avatar_data, is_active, created_at, updated_at FROM users WHERE email = $1 LIMIT 1',
    [email],
  );
  return result.rows[0] ?? null;
}

/**
 * 按 ID 查找用户（安全字段）
 */
export async function findById(id: string): Promise<UserRow | null> {
  const result = await db.query<UserRow>(`SELECT ${SAFE_COLUMNS} FROM users WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

export async function listUsers(options?: {
  limit?: number;
  starting_after?: string;
  search?: string;
}): Promise<{ data: UserRow[]; has_more: boolean }> {
  const limit = Math.min(Math.max(options?.limit ?? 10, 1), 100);
  const startingAfter = options?.starting_after;
  const search = options?.search;

  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  if (typeof startingAfter === 'string' && startingAfter.trim() !== '') {
    conditions.push(`created_at < (SELECT created_at FROM users WHERE id = $${String(paramIdx)})`);
    values.push(startingAfter);
    paramIdx++;
  }

  if (typeof search === 'string' && search.trim() !== '') {
    conditions.push(`(username ILIKE $${String(paramIdx)} OR email ILIKE $${String(paramIdx)})`);
    values.push(`%${search.trim()}%`);
    paramIdx++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const fetchLimit = limit + 1;
  values.push(fetchLimit);

  const sql = `
    SELECT ${SAFE_COLUMNS}
    FROM users
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT $${String(paramIdx)}
  `;

  const result = await db.query<UserRow>(sql, values);
  const hasMore = result.rows.length > limit;
  const data = hasMore ? result.rows.slice(0, limit) : result.rows;

  return { data, has_more: hasMore };
}

/**
 * 创建用户
 */
export async function createUser(data: {
  username: string;
  email: string;
  password: string;
  avatar_data?: string;
}): Promise<UserRow> {
  const id = await generateShortId('users');
  const passwordHash = hashPassword(data.password);
  const result = await db.query<UserRow>(
    `INSERT INTO users (id, username, email, password_hash, avatar_data) VALUES ($1, $2, $3, $4, $5) RETURNING ${SAFE_COLUMNS}`,
    [id, data.username, data.email, passwordHash, data.avatar_data ?? ''],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('Failed to create user');
  }
  return row;
}

/** 可更新的用户字段 */
export interface UserUpdateData {
  username?: string;
  email?: string;
  password?: string;
  avatar_data?: string;
  is_active?: boolean;
}

/**
 * 通用用户更新（动态构建 SQL，仅更新传入的字段）
 */
export async function updateUser(id: string, data: UserUpdateData): Promise<UserRow | null> {
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (data.username !== undefined) {
    setClauses.push(`username = $${paramIndex++}`);
    values.push(data.username);
  }
  if (data.email !== undefined) {
    setClauses.push(`email = $${paramIndex++}`);
    values.push(data.email);
  }
  if (data.password !== undefined) {
    setClauses.push(`password_hash = $${paramIndex++}`);
    values.push(hashPassword(data.password));
  }
  if (data.avatar_data !== undefined) {
    setClauses.push(`avatar_data = $${paramIndex++}`);
    values.push(data.avatar_data);
  }
  if (data.is_active !== undefined) {
    setClauses.push(`is_active = $${paramIndex++}`);
    values.push(data.is_active);
  }

  if (setClauses.length === 0) {
    return await findById(id);
  }

  values.push(id);
  const result = await db.query<UserRow>(
    `UPDATE users SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING ${SAFE_COLUMNS}`,
    values,
  );
  return result.rows[0] ?? null;
}

/**
 * 获取用户头像原始数据（Base64 Data URI）
 */
export async function getUserAvatarData(id: string): Promise<string | null> {
  const result = await db.query<{ avatar_data: string; [key: string]: unknown }>(
    'SELECT avatar_data FROM users WHERE id = $1',
    [id],
  );
  return result.rows[0]?.avatar_data ?? null;
}

/**
 * 删除用户
 */
export async function deleteUser(id: string): Promise<boolean> {
  const result = await db.query('DELETE FROM users WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * 统计用户数量
 */
export async function countUsers(): Promise<number> {
  const result = await db.query<{ count: string; [key: string]: unknown }>('SELECT COUNT(*) as count FROM users');
  const row = result.rows[0];
  if (!row) {
    return 0;
  }
  return Number.parseInt(row.count, 10);
}
