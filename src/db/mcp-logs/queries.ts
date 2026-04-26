// src/db/mcp-logs/queries.ts — MCP 日志 CRUD（冷热双表，单次写入）

import { db } from '@/db/client';
import type { McpGatewayContext } from '@/types';
import { createLogger } from '@/utils';
import type { McpLogEntry, McpLogListItem, McpLogQuery } from './types';
import { ENTRY_COLUMNS, LIST_COLUMNS } from './types';

const logger = createLogger('McpLogs');

// ==================== 写入 ====================

/**
 * 写入 MCP 日志记录（单次写入，直接写最终状态 completed/error）
 *
 * 同时写入窄热表（mcp_logs）和冷宽表（mcp_log_details），保持原子性。
 * 与 request_logs 侧不同，MCP 调用耗时极短，无需 processing 中间态。
 */
export async function insertMcpLog(ctx: McpGatewayContext): Promise<void> {
  const durationMs = ctx.timing.end !== undefined ? ctx.timing.end - ctx.timing.start : null;

  try {
    // 1. 写入窄热表
    await db.query(
      `INSERT INTO mcp_logs
         (id, virtual_mcp_id, mcp_provider_id, app_id, session_id,
          status, method, tool_name, error_message, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        ctx.id,
        ctx.virtualMcpId || null,
        ctx.mcpProviderId || null,
        ctx.appId ?? null,
        ctx.sessionId,
        ctx.status,
        ctx.method,
        ctx.toolName ?? null,
        ctx.errorMessage ?? null,
        durationMs,
      ],
    );

    // 2. 写入冷宽表（完整 McpGatewayContext 快照）
    await db.query(
      `INSERT INTO mcp_log_details (id, mcp_context)
       VALUES ($1, $2::jsonb)`,
      [ctx.id, JSON.stringify(ctx)],
    );

    logger.debug({ id: ctx.id, method: ctx.method, status: ctx.status }, 'MCP log recorded');
  } catch (error) {
    logger.error({ err: error, id: ctx.id }, 'Failed to insert MCP log');
    // 日志写入失败不影响主流程，仅记录错误
  }
}

// ==================== 读取 ====================

/**
 * 列出 MCP 日志（Offset 分页，仅查窄表，严禁 JOIN mcp_log_details）
 */
export async function listMcpLogs(query: McpLogQuery = {}): Promise<{
  data: McpLogListItem[];
  has_more: boolean;
  total: number;
}> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  if (typeof query.virtual_mcp_id === 'string' && query.virtual_mcp_id.trim() !== '') {
    conditions.push(`m.virtual_mcp_id = $${String(paramIdx++)}`);
    values.push(query.virtual_mcp_id);
  }

  if (typeof query.mcp_provider_id === 'string' && query.mcp_provider_id.trim() !== '') {
    conditions.push(`m.mcp_provider_id = $${String(paramIdx++)}`);
    values.push(query.mcp_provider_id);
  }

  if (typeof query.app_id === 'string' && query.app_id.trim() !== '') {
    conditions.push(`m.app_id = $${String(paramIdx++)}`);
    values.push(query.app_id);
  }

  if (typeof query.status === 'string' && query.status.trim() !== '') {
    conditions.push(`m.status = $${String(paramIdx++)}`);
    values.push(query.status);
  }

  if (typeof query.method === 'string' && query.method.trim() !== '') {
    conditions.push(`m.method = $${String(paramIdx++)}`);
    values.push(query.method);
  }

  if (typeof query.tool_name === 'string' && query.tool_name.trim() !== '') {
    conditions.push(`m.tool_name = $${String(paramIdx++)}`);
    values.push(query.tool_name);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
  const offset = Math.max(query.offset ?? 0, 0);

  // 先查 total（仅窄表 COUNT，无 JOIN）
  const countResult = await db.query<{ total: string }>(`SELECT COUNT(*) AS total FROM mcp_logs m ${whereClause}`, [
    ...values,
  ]);
  const total = Number.parseInt(countResult.rows[0]?.total ?? '0', 10);

  // 分页查询
  values.push(limit, offset);
  const dataResult = await db.query<Record<string, unknown>>(
    `SELECT ${LIST_COLUMNS}
     FROM mcp_logs m
     ${whereClause}
     ORDER BY m.created_at DESC
     LIMIT $${String(paramIdx)} OFFSET $${String(paramIdx + 1)}`,
    values,
  );

  const data = dataResult.rows as unknown as McpLogListItem[];

  return { data, has_more: offset + data.length < total, total };
}

/**
 * 按 ID 查询 MCP 日志详情（单行点查，允许 JOIN 冷表）
 */
export async function getMcpLogById(id: string): Promise<McpLogEntry | null> {
  const result = await db.query<Record<string, unknown>>(
    `SELECT ${ENTRY_COLUMNS}
     FROM mcp_logs m
     LEFT JOIN mcp_log_details d ON m.id = d.id
     WHERE m.id = $1`,
    [id],
  );
  return (result.rows[0] as unknown as McpLogEntry | undefined) ?? null;
}

/**
 * 删除单条 MCP 日志（双表删除）
 * 返回是否实际删除了记录
 */
export async function deleteMcpLogById(id: string): Promise<boolean> {
  const result = await db.query('DELETE FROM mcp_logs WHERE id = $1', [id]);
  await db.query('DELETE FROM mcp_log_details WHERE id = $1', [id]);

  const deleted = (result.rowCount ?? 0) > 0;
  if (deleted) {
    logger.debug({ id }, 'MCP log deleted');
  }
  return deleted;
}
