// src/db/mcp-logs/queries.ts — MCP 日志查询
// 写入与读取（Stripe 风格游标分页）

import { db } from '@/db/client';
import { createLogger } from '@/utils';
import type { McpLogCreateInput, McpLogRow } from './types';

const logger = createLogger('McpLogs');

// ==================== 写入 ====================

/**
 * 写入 MCP 日志记录
 */
export async function insertMcpLog(input: McpLogCreateInput): Promise<void> {
  await db.query(
    `INSERT INTO mcp_logs (id, virtual_mcp_id, mcp_provider_id, app_id, session_id, direction, method, params, result, error, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11)`,
    [
      input.id,
      input.virtual_mcp_id ?? null,
      input.mcp_provider_id ?? null,
      input.app_id ?? null,
      input.session_id ?? '',
      input.direction,
      input.method,
      JSON.stringify(input.params ?? {}),
      JSON.stringify(input.result ?? {}),
      input.error ? JSON.stringify(input.error) : null,
      input.duration_ms ?? 0,
    ],
  );

  logger.debug({ id: input.id, method: input.method, direction: input.direction }, 'MCP log recorded');
}

// ==================== 读取 ====================

/**
 * 列出 MCP 日志（Stripe 风格游标分页）
 */
export async function listMcpLogs(options?: {
  limit?: number;
  offset?: number;
  virtual_mcp_id?: string;
  mcp_provider_id?: string;
  app_id?: string;
  method?: string;
  direction?: string;
}): Promise<{ data: McpLogRow[]; has_more: boolean; total: number }> {
  const limit = Math.min(Math.max(options?.limit ?? 20, 1), 100);
  const offset = typeof options?.offset === 'number' ? Math.max(options.offset, 0) : 0;

  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  if (typeof options?.virtual_mcp_id === 'string' && options.virtual_mcp_id.trim() !== '') {
    conditions.push(`virtual_mcp_id = $${String(paramIdx)}`);
    values.push(options.virtual_mcp_id);
    paramIdx++;
  }

  if (typeof options?.mcp_provider_id === 'string' && options.mcp_provider_id.trim() !== '') {
    conditions.push(`mcp_provider_id = $${String(paramIdx)}`);
    values.push(options.mcp_provider_id);
    paramIdx++;
  }

  if (typeof options?.app_id === 'string' && options.app_id.trim() !== '') {
    conditions.push(`app_id = $${String(paramIdx)}`);
    values.push(options.app_id);
    paramIdx++;
  }

  if (typeof options?.method === 'string' && options.method.trim() !== '') {
    conditions.push(`method = $${String(paramIdx)}`);
    values.push(options.method);
    paramIdx++;
  }

  if (typeof options?.direction === 'string' && options.direction.trim() !== '') {
    conditions.push(`direction = $${String(paramIdx)}`);
    values.push(options.direction);
    paramIdx++;
  }

  const baseWhereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await db.query(`SELECT COUNT(*) AS total FROM mcp_logs ${baseWhereClause}`, values);
  const total = Number.parseInt((countResult.rows[0] as { total: string } | undefined)?.total ?? '0', 10);

  if (offset > 0) {
    // offset will be appended later
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  values.push(limit, offset);

  const sql = `SELECT * FROM mcp_logs ${whereClause} ORDER BY created_at DESC LIMIT $${String(paramIdx)} OFFSET $${String(paramIdx + 1)}`;
  const result = await db.query<McpLogRow>(sql, values);
  const data = result.rows;

  return { data, has_more: offset + data.length < total, total };
}

/**
 * 按 ID 查询 MCP 日志详情
 */
export async function getMcpLogById(id: string): Promise<McpLogRow | null> {
  const result = await db.query<McpLogRow>('SELECT * FROM mcp_logs WHERE id = $1', [id]);
  return result.rows[0] ?? null;
}

/**
 * 批量删除 MCP 日志
 */
export async function deleteMcpLogsBatch(ids: string[]): Promise<number> {
  if (ids.length === 0) {
    return 0;
  }

  const placeholders = ids.map((_, i) => `$${String(i + 1)}`).join(', ');
  const result = await db.query(`DELETE FROM mcp_logs WHERE id IN (${placeholders})`, ids);

  const count = result.rowCount ?? 0;
  logger.debug({ deletedCount: count, requestedCount: ids.length }, 'Batch MCP logs deleted in db');
  return count;
}
