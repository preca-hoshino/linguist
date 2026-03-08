// src/db/request-logs/read.ts — 请求日志查询操作

import { db } from '../client';
import { createLogger, logColors } from '../../utils';
import { ENTRY_COLUMNS } from './types';
import type { RequestLogEntry, RequestLogQuery } from './types';

const logger = createLogger('RequestLog', logColors.bold + logColors.blue);

/**
 * 查询请求日志列表（含 gateway_context 完整快照）
 *
 * 优化：移除不必要的事务包装，直接使用两次独立查询（COUNT + SELECT）。
 * 读操作不需要事务隔离，避免 BEGIN/COMMIT 开销。
 */
export async function queryRequestLogs(query: RequestLogQuery = {}): Promise<{
  data: RequestLogEntry[];
  total: number;
}> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (query.status !== undefined) {
    conditions.push(`status = $${String(idx++)}`);
    values.push(query.status);
  }
  if (query.request_model !== undefined && query.request_model !== '') {
    conditions.push(`request_model = $${String(idx++)}`);
    values.push(query.request_model);
  }
  if (query.provider_kind !== undefined && query.provider_kind !== '') {
    conditions.push(`provider_kind = $${String(idx++)}`);
    values.push(query.provider_kind);
  }
  if (query.error_type !== undefined && query.error_type !== '') {
    conditions.push(`error_type = $${String(idx++)}`);
    values.push(query.error_type);
  }
  if (query.api_key_prefix !== undefined && query.api_key_prefix !== '') {
    conditions.push(`api_key_prefix = $${String(idx++)}`);
    values.push(query.api_key_prefix);
  }
  if (query.is_stream !== undefined) {
    conditions.push(`is_stream = $${String(idx++)}`);
    values.push(query.is_stream);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // 查总数（不含分页参数）
  const countResult = await db.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM request_logs ${whereClause}`,
    values,
  );
  const countRow = countResult.rows[0];
  const total = countRow !== undefined ? parseInt(countRow.count, 10) : 0;

  // 查数据（追加分页参数）
  const limit = Math.min(query.limit ?? 50, 200);
  const offset = query.offset ?? 0;
  const dataValues = [...values, limit, offset];

  const dataResult = await db.query<RequestLogEntry>(
    `SELECT ${ENTRY_COLUMNS}
     FROM request_logs ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${String(idx)} OFFSET $${String(idx + 1)}`,
    dataValues,
  );

  return { data: dataResult.rows, total };
}

/**
 * 按 ID 查询请求日志详情
 */
export async function getRequestLogById(id: string): Promise<RequestLogEntry | null> {
  const result = await db.query<RequestLogEntry>(`SELECT ${ENTRY_COLUMNS} FROM request_logs WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

/**
 * 按 ID 删除单条请求日志
 * 返回是否实际删除了记录
 */
export async function deleteRequestLogById(id: string): Promise<boolean> {
  const result = await db.query(`DELETE FROM request_logs WHERE id = $1`, [id]);
  const deleted = (result.rowCount ?? 0) > 0;
  if (deleted) {
    logger.info({ requestId: id }, 'Request log deleted');
  }
  return deleted;
}
