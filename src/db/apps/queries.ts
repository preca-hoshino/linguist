// src/db/apps/queries.ts — 应用（App）CRUD 查询
// Stripe 风格游标分页、嵌套白名单管理

import { db, withTransaction } from '@/db/client';
import { generateShortId } from '@/db/id-generator';
import { buildBatchInsert, buildUpdateSet, createLogger } from '@/utils';
import { invalidateAppCache } from './cache';
import type { AppCreateInput, AppRow, AppUpdateInput } from './types';

const logger = createLogger('Apps');

// ==================== 内部常量 ====================

const APP_SELECT = `
  SELECT a.*,
         COALESCE(
           array_agg(DISTINCT aam.virtual_model_id) FILTER (WHERE aam.virtual_model_id IS NOT NULL),
           '{}'
         ) AS allowed_model_ids,
         COALESCE(
           array_agg(DISTINCT aamcp.virtual_mcp_id) FILTER (WHERE aamcp.virtual_mcp_id IS NOT NULL),
           '{}'
         ) AS allowed_mcp_ids
  FROM apps a
  LEFT JOIN app_allowed_models aam ON aam.app_id = a.id
  LEFT JOIN app_allowed_mcps aamcp ON aamcp.app_id = a.id
`;

// ==================== CRUD 函数 ====================

/**
 * 创建应用
 * 生成短 ID → INSERT apps → 批量 INSERT app_allowed_models
 */
export async function createApp(input: AppCreateInput): Promise<AppRow> {
  const id = await generateShortId('apps');
  const { name, allowed_model_ids: allowedModelIds = [], allowed_mcp_ids: allowedMcpIds = [] } = input;

  return await withTransaction(async (tx) => {
    await tx.query(`INSERT INTO apps (id, name) VALUES ($1, $2)`, [id, name]);

    // 批量插入白名单
    if (allowedModelIds.length > 0) {
      const rows = allowedModelIds.map((modelId) => [id, modelId]);
      const batch = buildBatchInsert(rows, 2);
      await tx.query(
        `INSERT INTO app_allowed_models (app_id, virtual_model_id) VALUES ${batch.valuesClause}`,
        batch.values,
      );
    }

    // 批量插入 MCP 白名单
    if (allowedMcpIds.length > 0) {
      const rows = allowedMcpIds.map((mcpId) => [id, mcpId]);
      const batch = buildBatchInsert(rows, 2);
      await tx.query(
        `INSERT INTO app_allowed_mcps (app_id, virtual_mcp_id) VALUES ${batch.valuesClause}`,
        batch.values,
      );
    }

    // 查询完整结果返回
    const result = await tx.query<AppRow>(`${APP_SELECT} WHERE a.id = $1 GROUP BY a.id`, [id]);

    const row = result.rows[0];
    if (!row) {
      throw new Error('Failed to create app: no row returned');
    }

    logger.info({ id: row.id, name }, 'App created');
    invalidateAppCache();
    return row;
  });
}

/**
 * 列出应用（Offset 分页）
 * @param options.limit 每页数量（默认 10，最大 100）
 * @param options.offset 偏移量（默认 0）
 * @param options.search 搜索关键词（名称模糊匹配）
 */
export async function listApps(options?: {
  limit?: number;
  offset?: number;
  search?: string;
  is_active?: boolean;
}): Promise<{ data: AppRow[]; has_more: boolean; total: number }> {
  const limit = Math.min(Math.max(options?.limit ?? 10, 1), 100);
  const offset = Math.max(options?.offset ?? 0, 0);
  const search = options?.search;
  const isActive = options?.is_active;

  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  // 搜索过滤
  if (typeof search === 'string' && search.trim() !== '') {
    conditions.push(`a.name ILIKE $${String(paramIdx)}`);
    values.push(`%${search.trim()}%`);
    paramIdx++;
  }

  // 状态过滤
  if (typeof isActive === 'boolean') {
    conditions.push(`a.is_active = $${String(paramIdx)}`);
    values.push(isActive);
    paramIdx++;
  }

  const baseWhereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // 单独计算 total
  const countSql = `SELECT COUNT(*) AS total FROM apps a ${baseWhereClause}`;
  const countResult = await db.query(countSql, [...values]);
  const total = Number.parseInt((countResult.rows[0] as { total: string } | undefined)?.total ?? '0', 10);

  const whereClause = baseWhereClause;
  values.push(limit, offset);

  const sql = `
    ${APP_SELECT}
    ${whereClause}
    GROUP BY a.id
    ORDER BY a.created_at DESC
    LIMIT $${String(paramIdx)} OFFSET $${String(paramIdx + 1)}
  `;

  const result = await db.query<AppRow>(sql, values);
  const data = result.rows;

  return { data, has_more: offset + data.length < total, total };
}

/**
 * 按 ID 查询应用详情（含 allowed_model_ids）
 */
export async function getAppById(id: string): Promise<AppRow | null> {
  const result = await db.query<AppRow>(`${APP_SELECT} WHERE a.id = $1 GROUP BY a.id`, [id]);
  return result.rows[0] ?? null;
}

/**
 * 更新应用（Stripe 风格：POST 部分更新）
 * 支持更新基本字段 + 替换白名单
 */
export async function updateApp(id: string, updates: AppUpdateInput): Promise<AppRow | null> {
  const { allowed_model_ids: allowedModelIds, allowed_mcp_ids: allowedMcpIds, ...fieldUpdates } = updates;

  return await withTransaction(async (tx) => {
    // 更新基本字段
    const update = buildUpdateSet({
      name: fieldUpdates.name,
      is_active: fieldUpdates.is_active,
    });

    if (update) {
      update.values.push(id);
      const result = await tx.query(
        `UPDATE apps SET ${update.setClause} WHERE id = $${String(update.nextIdx)}`,
        update.values,
      );
      if (result.rowCount === 0) {
        return null;
      }
    }

    // 替换白名单（传入则全量替换，未传则不动）
    if (allowedModelIds !== undefined) {
      await tx.query('DELETE FROM app_allowed_models WHERE app_id = $1', [id]);
      if (allowedModelIds.length > 0) {
        const rows = allowedModelIds.map((modelId) => [id, modelId]);
        const batch = buildBatchInsert(rows, 2);
        await tx.query(
          `INSERT INTO app_allowed_models (app_id, virtual_model_id) VALUES ${batch.valuesClause}`,
          batch.values,
        );
      }
    }

    // 替换 MCP 白名单
    if (allowedMcpIds !== undefined) {
      await tx.query('DELETE FROM app_allowed_mcps WHERE app_id = $1', [id]);
      if (allowedMcpIds.length > 0) {
        const rows = allowedMcpIds.map((mcpId) => [id, mcpId]);
        const batch = buildBatchInsert(rows, 2);
        await tx.query(
          `INSERT INTO app_allowed_mcps (app_id, virtual_mcp_id) VALUES ${batch.valuesClause}`,
          batch.values,
        );
      }
    }

    // 查询完整结果返回
    const result = await tx.query<AppRow>(`${APP_SELECT} WHERE a.id = $1 GROUP BY a.id`, [id]);

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    logger.info({ id }, 'App updated');
    invalidateAppCache();
    return row;
  });
}

/**
 * 删除应用（CASCADE 级联删除 api_keys + app_allowed_models）
 */
export async function deleteApp(id: string): Promise<boolean> {
  const result = await db.query('DELETE FROM apps WHERE id = $1 RETURNING id', [id]);

  if (result.rowCount === 0) {
    return false;
  }

  invalidateAppCache();
  logger.info({ id }, 'App deleted');
  return true;
}

/**
 * 轮换应用的 API Key
 */
export async function rotateAppKey(id: string): Promise<AppRow | null> {
  const result = await db.query<AppRow>(
    `
    UPDATE apps 
    SET api_key = 'lk-' || encode(gen_random_bytes(24), 'hex') 
    WHERE id = $1 
    RETURNING *
  `,
    [id],
  );

  if (result.rowCount === 0) {
    return null;
  }

  invalidateAppCache();
  logger.info({ id }, 'App API key rotated');
  return result.rows[0] ?? null;
}
