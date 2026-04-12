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
    `INSERT INTO mcp_logs (id, virtual_mcp_id, provider_mcp_id, session_id, direction, method, params, result, error, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10)`,
    [
      input.id,
      input.virtual_mcp_id ?? null,
      input.provider_mcp_id ?? null,
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
  starting_after?: string;
  virtual_mcp_id?: string;
  provider_mcp_id?: string;
  method?: string;
  direction?: string;
}): Promise<{ data: McpLogRow[]; has_more: boolean; total: number }> {
  const limit = Math.min(Math.max(options?.limit ?? 20, 1), 100);
  const startingAfter = options?.starting_after;

  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  if (typeof options?.virtual_mcp_id === 'string' && options.virtual_mcp_id.trim() !== '') {
    conditions.push(`virtual_mcp_id = $${String(paramIdx)}`);
    values.push(options.virtual_mcp_id);
    paramIdx++;
  }

  if (typeof options?.provider_mcp_id === 'string' && options.provider_mcp_id.trim() !== '') {
    conditions.push(`provider_mcp_id = $${String(paramIdx)}`);
    values.push(options.provider_mcp_id);
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

  if (typeof startingAfter === 'string' && startingAfter.trim() !== '') {
    conditions.push(`created_at < (SELECT created_at FROM mcp_logs WHERE id = $${String(paramIdx)})`);
    values.push(startingAfter);
    paramIdx++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const fetchLimit = limit + 1;
  values.push(fetchLimit);

  const sql = `SELECT * FROM mcp_logs ${whereClause} ORDER BY created_at DESC LIMIT $${String(paramIdx)}`;
  const result = await db.query<McpLogRow>(sql, values);
  const hasMore = result.rows.length > limit;
  const data = hasMore ? result.rows.slice(0, limit) : result.rows;

  return { data, has_more: hasMore, total };
}

/**
 * 按 ID 查询 MCP 日志详情
 */
export async function getMcpLogById(id: string): Promise<McpLogRow | null> {
  const result = await db.query<McpLogRow>('SELECT * FROM mcp_logs WHERE id = $1', [id]);
  return result.rows[0] ?? null;
}
