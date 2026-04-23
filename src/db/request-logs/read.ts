// src/db/request-logs/read.ts — 请求日志查询操作

import { db } from '@/db/client';
import { buildInClause, createLogger, logColors } from '@/utils';
import type { RequestLogEntry, RequestLogQuery } from './types';
import { ENTRY_COLUMNS } from './types';

const logger = createLogger('RequestLog', logColors.bold + logColors.blue);

/**
 * 查询请求日志列表（含 gateway_context 完整快照，切换至 Stripe 风格游标分页）
 */
export async function queryRequestLogs(query: RequestLogQuery = {}): Promise<{
  data: RequestLogEntry[];
  has_more: boolean;
}> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  let baseFrom = 'request_logs r';

  // 多 Tag 过滤支持
  const statusIn = buildInClause('r.status', query.status, idx);
  if (statusIn) {
    conditions.push(statusIn.clause);
    values.push(...statusIn.values);
    idx = statusIn.nextIdx;
  }

  const kindIn = buildInClause('r.provider_kind', query.provider_kind, idx);
  if (kindIn) {
    conditions.push(kindIn.clause);
    values.push(...kindIn.values);
    idx = kindIn.nextIdx;
  }

  const pidIn = buildInClause('r.provider_id', query.provider_id, idx);
  if (pidIn) {
    conditions.push(pidIn.clause);
    values.push(...pidIn.values);
    idx = pidIn.nextIdx;
  }

  const errIn = buildInClause('r.error_type', query.error_type, idx);
  if (errIn) {
    conditions.push(errIn.clause);
    values.push(...errIn.values);
    idx = errIn.nextIdx;
  }

  if (query.request_model !== undefined && query.request_model !== '') {
    conditions.push(`r.request_model ILIKE $${String(idx++)}`);
    values.push(`%${query.request_model}%`);
  }

  if (query.user_format !== undefined && query.user_format !== '') {
    baseFrom = 'request_logs r INNER JOIN request_logs_details d ON r.id = d.id';
    const fmtIn = buildInClause("d.gateway_context->>'userFormat'", query.user_format, idx);
    if (fmtIn) {
      conditions.push(fmtIn.clause);
      values.push(...fmtIn.values);
      idx = fmtIn.nextIdx;
    }
  }

  if (query.is_stream !== undefined) {
    conditions.push(`r.is_stream = $${String(idx++)}`);
    values.push(query.is_stream);
  }

  // app_id 过滤：通过 gateway_context JSONB 中的 appId 字段
  if (query.app_id !== undefined) {
    // 确保 JOIN 了 details 表
    if (!baseFrom.includes('request_logs_details')) {
      baseFrom = 'request_logs r INNER JOIN request_logs_details d ON r.id = d.id';
    }
    const appIn = buildInClause("d.gateway_context->>'appId'", query.app_id, idx);
    if (appIn) {
      conditions.push(appIn.clause);
      values.push(...appIn.values);
      idx = appIn.nextIdx;
    }
  }

  // 游标分页
  if (typeof query.starting_after === 'string' && query.starting_after.trim() !== '') {
    conditions.push(`r.created_at < (SELECT created_at FROM request_logs WHERE id = $${String(idx++)})`);
    values.push(query.starting_after);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const fetchLimit = limit + 1; // 多查一条探知 has_more

  values.push(fetchLimit);

  const dataResult = await db.query<Record<string, unknown>>(
    `SELECT ${ENTRY_COLUMNS}
     FROM (
       SELECT r.id 
       FROM ${baseFrom} 
       ${whereClause}
       ORDER BY r.created_at DESC
       LIMIT $${String(idx)}
     ) AS pointer
     JOIN request_logs r ON pointer.id = r.id
     LEFT JOIN request_logs_details d ON pointer.id = d.id
     ORDER BY r.created_at DESC`,
    values,
  );

  const hasMore = dataResult.rows.length > limit;
  const data = hasMore ? dataResult.rows.slice(0, limit) : dataResult.rows;

  return { data: data as unknown as RequestLogEntry[], has_more: hasMore };
}

/**
 * 按 ID 查询请求日志详情
 */
export async function getRequestLogById(id: string): Promise<RequestLogEntry | null> {
  const result = await db.query<Record<string, unknown>>(
    `SELECT ${ENTRY_COLUMNS} FROM request_logs r LEFT JOIN request_logs_details d ON r.id = d.id WHERE r.id = $1`,
    [id],
  );
  return (result.rows[0] as unknown as RequestLogEntry | undefined) ?? null;
}

/**
 * 按 ID 删除单条请求日志
 * 返回是否实际删除了记录
 */
export async function deleteRequestLogById(id: string): Promise<boolean> {
  // 冷热分离后需一起删除
  const result = await db.query(`DELETE FROM request_logs WHERE id = $1`, [id]);
  await db.query(`DELETE FROM request_logs_details WHERE id = $1`, [id]);

  const deleted = (result.rowCount ?? 0) > 0;
  if (deleted) {
    logger.info({ requestId: id }, 'Request log deleted');
  }
  return deleted;
}
