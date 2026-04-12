// src/db/mcp-virtual-servers/queries.ts — 虚拟 MCP CRUD 查询
// Stripe 风格游标分页

import { db, withTransaction } from '@/db/client';
import { generateShortId } from '@/db/id-generator';
import { buildUpdateSet, createLogger } from '@/utils';
import type { McpVirtualServerCreateInput, McpVirtualServerRow, McpVirtualServerUpdateInput } from './types';

const logger = createLogger('McpVirtualServers');

// ==================== CRUD 函数 ====================

/**
 * 创建虚拟 MCP
 */
export async function createMcpVirtualServer(input: McpVirtualServerCreateInput): Promise<McpVirtualServerRow> {
  const id = await generateShortId('mcp_virtual_servers');

  const result = await db.query<McpVirtualServerRow>(
    `INSERT INTO mcp_virtual_servers (id, name, description, mcp_provider_id, tool_filter_mode, tool_filter_list)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING *`,
    [
      id,
      input.name,
      input.description ?? '',
      input.mcp_provider_id,
      input.tool_filter_mode ?? 'all',
      JSON.stringify(input.tool_filter_list ?? []),
    ],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error('Failed to create MCP virtual server: no row returned');
  }

  logger.info({ id: row.id, name: input.name }, 'MCP virtual server created');
  return row;
}

/**
 * 列出虚拟 MCP（Stripe 风格游标分页）
 */
export async function listMcpVirtualServers(options?: {
  limit?: number;
  offset?: number;
  search?: string;
  is_active?: boolean;
  mcp_provider_id?: string;
}): Promise<{ data: McpVirtualServerRow[]; has_more: boolean; total: number }> {
  const limit = Math.min(Math.max(options?.limit ?? 10, 1), 100);
  const offset = typeof options?.offset === 'number' ? Math.max(options.offset, 0) : 0;
  const search = options?.search;
  const isActive = options?.is_active;
  const providerId = options?.mcp_provider_id;

  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  if (typeof search === 'string' && search.trim() !== '') {
    conditions.push(`name ILIKE $${String(paramIdx)}`);
    values.push(`%${search.trim()}%`);
    paramIdx++;
  }

  if (typeof isActive === 'boolean') {
    conditions.push(`is_active = $${String(paramIdx)}`);
    values.push(isActive);
    paramIdx++;
  }

  if (typeof providerId === 'string' && providerId.trim() !== '') {
    conditions.push(`mcp_provider_id = $${String(paramIdx)}`);
    values.push(providerId);
    paramIdx++;
  }

  const baseWhereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await db.query(`SELECT COUNT(*) AS total FROM mcp_virtual_servers ${baseWhereClause}`, values);
  const total = Number.parseInt((countResult.rows[0] as { total: string } | undefined)?.total ?? '0', 10);

  if (offset > 0) {
    // offset will be appended later
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  values.push(limit, offset);

  const sql = `SELECT * FROM mcp_virtual_servers ${whereClause} ORDER BY created_at DESC LIMIT $${String(paramIdx)} OFFSET $${String(paramIdx + 1)}`;
  const result = await db.query<McpVirtualServerRow>(sql, values);
  const data = result.rows;

  return { data, has_more: offset + data.length < total, total };
}

/**
 * 按 ID 查询虚拟 MCP
 */
export async function getMcpVirtualServerById(id: string): Promise<McpVirtualServerRow | null> {
  const result = await db.query<McpVirtualServerRow>('SELECT * FROM mcp_virtual_servers WHERE id = $1', [id]);
  return result.rows[0] ?? null;
}

/**
 * 更新虚拟 MCP
 */
export async function updateMcpVirtualServer(
  id: string,
  updates: McpVirtualServerUpdateInput,
): Promise<McpVirtualServerRow | null> {
  return await withTransaction(async (tx) => {
    const fieldUpdates: Record<string, unknown> = {};

    if (updates.name !== undefined) {
      fieldUpdates.name = updates.name;
    }
    if (updates.description !== undefined) {
      fieldUpdates.description = updates.description;
    }
    if (updates.mcp_provider_id !== undefined) {
      fieldUpdates.mcp_provider_id = updates.mcp_provider_id;
    }
    if (updates.tool_filter_mode !== undefined) {
      fieldUpdates.tool_filter_mode = updates.tool_filter_mode;
    }
    if (updates.tool_filter_list !== undefined) {
      fieldUpdates.tool_filter_list = JSON.stringify(updates.tool_filter_list);
    }
    if (updates.is_active !== undefined) {
      fieldUpdates.is_active = updates.is_active;
    }

    const update = buildUpdateSet(fieldUpdates);
    if (!update) {
      return await getMcpVirtualServerById(id);
    }

    update.values.push(id);
    const result = await tx.query<McpVirtualServerRow>(
      `UPDATE mcp_virtual_servers SET ${update.setClause}, updated_at = NOW() WHERE id = $${String(update.nextIdx)} RETURNING *`,
      update.values,
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    logger.info({ id }, 'MCP virtual server updated');
    return row;
  });
}

/**
 * 删除虚拟 MCP
 */
export async function deleteMcpVirtualServer(id: string): Promise<boolean> {
  const result = await db.query('DELETE FROM mcp_virtual_servers WHERE id = $1 RETURNING id', [id]);

  if (result.rowCount === 0) {
    return false;
  }

  logger.info({ id }, 'MCP virtual server deleted');
  return true;
}
