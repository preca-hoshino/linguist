// src/db/mcp-providers/queries.ts — 提供商 MCP CRUD 查询
// offset 分页

import { db, withTransaction } from '@/db/client';
import { generateShortId } from '@/db/id-generator';
import { buildUpdateSet, createLogger } from '@/utils';
import type { McpProviderCreateInput, McpProviderRow, McpProviderUpdateInput } from './types';

const logger = createLogger('McpProviders');

// ==================== CRUD 函数 ====================

/**
 * 创建提供商 MCP
 */
export async function createMcpProvider(input: McpProviderCreateInput): Promise<McpProviderRow> {
  const id = await generateShortId('mcp_providers');

  const result = await db.query<McpProviderRow>(
    `INSERT INTO mcp_providers (id, name, kind, base_url, credential_type, credential, config)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
     RETURNING *`,
    [
      id,
      input.name,
      input.kind,
      input.base_url ?? '',
      input.credential_type ?? 'api_key',
      JSON.stringify(input.credential ?? []),
      JSON.stringify(input.config ?? {}),
    ],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error('Failed to create MCP provider: no row returned');
  }

  logger.info({ id: row.id, name: input.name }, 'MCP provider created');
  return row;
}

/**
 * 列出提供商 MCP（offset 分页）
 */
export async function listMcpProviders(options?: {
  limit?: number;
  offset?: number;
  search?: string;
  is_active?: boolean;
  kind?: string;
}): Promise<{ data: McpProviderRow[]; has_more: boolean; total: number }> {
  const limit = Math.min(Math.max(options?.limit ?? 10, 1), 100);
  const offset = typeof options?.offset === 'number' ? Math.max(options.offset, 0) : 0;
  const search = options?.search;
  const isActive = options?.is_active;

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

  if (typeof options?.kind === 'string' && options.kind.trim() !== '') {
    conditions.push(`kind = $${String(paramIdx)}`);
    values.push(options.kind.trim());
    paramIdx++;
  }

  const baseWhereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await db.query(`SELECT COUNT(*) AS total FROM mcp_providers ${baseWhereClause}`, values);
  const total = Number.parseInt((countResult.rows[0] as { total: string } | undefined)?.total ?? '0', 10);

  if (offset > 0) {
    // We append OFFSET as a plain statement, not parameterized in WHERE
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  values.push(limit, offset);
  const sql = `SELECT * FROM mcp_providers ${whereClause} ORDER BY created_at DESC LIMIT $${String(paramIdx)} OFFSET $${String(paramIdx + 1)}`;
  const result = await db.query<McpProviderRow>(sql, values);
  const data = result.rows;

  return { data, has_more: offset + data.length < total, total };
}

/**
 * 按 ID 查询提供商 MCP
 */
export async function getMcpProviderById(id: string): Promise<McpProviderRow | null> {
  const result = await db.query<McpProviderRow>('SELECT * FROM mcp_providers WHERE id = $1', [id]);
  return result.rows[0] ?? null;
}

/**
 * 更新提供商 MCP
 */
export async function updateMcpProvider(id: string, updates: McpProviderUpdateInput): Promise<McpProviderRow | null> {
  return await withTransaction(async (tx) => {
    const fieldUpdates: Record<string, unknown> = {};

    if (updates.name !== undefined) {
      fieldUpdates.name = updates.name;
    }
    if (updates.kind !== undefined) {
      fieldUpdates.kind = updates.kind;
    }
    if (updates.base_url !== undefined) {
      fieldUpdates.base_url = updates.base_url;
    }
    if (updates.credential_type !== undefined) {
      fieldUpdates.credential_type = updates.credential_type;
    }
    if (updates.credential !== undefined) {
      fieldUpdates.credential = JSON.stringify(updates.credential);
    }
    if (updates.config !== undefined) {
      fieldUpdates.config = JSON.stringify(updates.config);
    }
    if (updates.is_active !== undefined) {
      fieldUpdates.is_active = updates.is_active;
    }

    const update = buildUpdateSet(fieldUpdates);
    if (!update) {
      return await getMcpProviderById(id);
    }

    update.values.push(id);
    const result = await tx.query<McpProviderRow>(
      `UPDATE mcp_providers SET ${update.setClause}, updated_at = NOW() WHERE id = $${String(update.nextIdx)} RETURNING *`,
      update.values,
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    logger.info({ id }, 'MCP provider updated');
    return row;
  });
}

/**
 * 删除提供商 MCP（CASCADE 级联删除关联的虚拟 MCP）
 */
export async function deleteMcpProvider(id: string): Promise<boolean> {
  const result = await db.query('DELETE FROM mcp_providers WHERE id = $1 RETURNING id', [id]);

  if (result.rowCount === 0) {
    return false;
  }

  logger.info({ id }, 'MCP provider deleted');
  return true;
}
