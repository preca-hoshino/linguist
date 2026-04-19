// src/db/mcp-virtual-servers/queries.ts — 虚拟 MCP CRUD 查询
// 表名: virtual_mcps；Stripe 风格游标分页

import { db, withTransaction } from '@/db/client';
import { generateShortId } from '@/db/id-generator';
import { buildUpdateSet, createLogger } from '@/utils';
import type { VirtualMcpCreateInput, VirtualMcpRow, VirtualMcpUpdateInput } from './types';

const logger = createLogger('VirtualMcps');

// ==================== CRUD 函数 ====================

/**
 * 创建虚拟 MCP
 */
export async function createVirtualMcp(input: VirtualMcpCreateInput): Promise<VirtualMcpRow> {
  const id = await generateShortId('virtual_mcps');

  const result = await db.query<VirtualMcpRow>(
    `INSERT INTO virtual_mcps (id, name, description, mcp_provider_id, config)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING *`,
    [id, input.name, input.description ?? '', input.mcp_provider_id, JSON.stringify(input.config ?? {})],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error('Failed to create virtual MCP: no row returned');
  }

  logger.info({ id: row.id, name: input.name }, 'Virtual MCP created');
  return row;
}

/**
 * 列出虚拟 MCP（Stripe 风格游标分页）
 */
export async function listVirtualMcps(options?: {
  limit?: number;
  offset?: number;
  search?: string;
  is_active?: boolean;
  mcp_provider_id?: string;
}): Promise<{ data: VirtualMcpRow[]; has_more: boolean; total: number }> {
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

  const countResult = await db.query(`SELECT COUNT(*) AS total FROM virtual_mcps ${baseWhereClause}`, values);
  const total = Number.parseInt((countResult.rows[0] as { total: string } | undefined)?.total ?? '0', 10);

  if (offset > 0) {
    // offset will be appended later
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  values.push(limit, offset);

  const sql = `SELECT * FROM virtual_mcps ${whereClause} ORDER BY created_at DESC LIMIT $${String(paramIdx)} OFFSET $${String(paramIdx + 1)}`;
  const result = await db.query<VirtualMcpRow>(sql, values);
  const data = result.rows;

  return { data, has_more: offset + data.length < total, total };
}

/**
 * 按 ID 查询虚拟 MCP
 */
export async function getVirtualMcpById(id: string): Promise<VirtualMcpRow | null> {
  const result = await db.query<VirtualMcpRow>('SELECT * FROM virtual_mcps WHERE id = $1', [id]);
  return result.rows[0] ?? null;
}

/**
 * 按用户自定义名字查询虚拟 MCP（仅活跃记录）
 * 供外部网关路由使用：X-Mcp-Name header → 内部 VirtualMcpRow
 */
export async function getVirtualMcpByName(name: string): Promise<VirtualMcpRow | null> {
  const result = await db.query<VirtualMcpRow>('SELECT * FROM virtual_mcps WHERE name = $1 AND is_active = true', [
    name,
  ]);
  return result.rows[0] ?? null;
}

/**
 * 更新虚拟 MCP
 */
export async function updateVirtualMcp(id: string, updates: VirtualMcpUpdateInput): Promise<VirtualMcpRow | null> {
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
    if (updates.config !== undefined) {
      fieldUpdates.config = JSON.stringify(updates.config);
    }
    if (updates.is_active !== undefined) {
      fieldUpdates.is_active = updates.is_active;
    }

    const update = buildUpdateSet(fieldUpdates);
    if (!update) {
      return await getVirtualMcpById(id);
    }

    update.values.push(id);
    const result = await tx.query<VirtualMcpRow>(
      `UPDATE virtual_mcps SET ${update.setClause}, updated_at = NOW() WHERE id = $${String(update.nextIdx)} RETURNING *`,
      update.values,
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    logger.info({ id }, 'Virtual MCP updated');
    return row;
  });
}

/**
 * 删除虚拟 MCP
 */
export async function deleteVirtualMcp(id: string): Promise<boolean> {
  const result = await db.query('DELETE FROM virtual_mcps WHERE id = $1 RETURNING id', [id]);

  if (result.rowCount === 0) {
    return false;
  }

  logger.info({ id }, 'Virtual MCP deleted');
  return true;
}
