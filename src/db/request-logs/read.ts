// src/db/request-logs/read.ts — 请求日志查询操作

import { db } from '@/db/client';
import { buildInClause, createLogger, logColors } from '@/utils';
import type { RequestLogEntry, RequestLogListItem, RequestLogQuery } from './types';
import { ENTRY_COLUMNS, LIST_COLUMNS } from './types';

const logger = createLogger('RequestLog', logColors.bold + logColors.blue);

/**
 * 查询请求日志列表（仅查 request_logs 窄表，严禁 JOIN request_log_details）
 *
 * 规则：
 * - app_id 过滤：r.app_id（走 idx_rl_appid_created 索引）
 * - user_format 过滤：r.user_format（走新 idx_rl_user_format 索引）
 * - 使用 Offset 分页：COUNT(*) + LIMIT $x OFFSET $y
 * - 返回 RequestLogListItem[]（不含 gateway_context）
 */
export async function queryRequestLogs(query: RequestLogQuery = {}): Promise<{
  data: RequestLogListItem[];
  has_more: boolean;
  total: number;
}> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

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

  // user_format 过滤：使用窄表列，无需 JOIN 宽表
  const fmtIn = buildInClause('r.user_format', query.user_format, idx);
  if (fmtIn) {
    conditions.push(fmtIn.clause);
    values.push(...fmtIn.values);
    idx = fmtIn.nextIdx;
  }

  if (query.is_stream !== undefined) {
    conditions.push(`r.is_stream = $${String(idx++)}`);
    values.push(query.is_stream);
  }

  // app_id 过滤：直接使用窄表原生列（走覆盖索引）
  const appIn = buildInClause('r.app_id', query.app_id, idx);
  if (appIn) {
    conditions.push(appIn.clause);
    values.push(...appIn.values);
    idx = appIn.nextIdx;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const offset = Math.max(query.offset ?? 0, 0);

  // 先查 total（窄表 COUNT，无 JOIN）
  const countResult = await db.query<{ total: string }>(`SELECT COUNT(*) AS total FROM request_logs r ${whereClause}`, [
    ...values,
  ]);
  const total = Number.parseInt(countResult.rows[0]?.total ?? '0', 10);

  // 分页查询（仅窄表，严禁 JOIN request_log_details）
  values.push(limit, offset);
  const dataResult = await db.query<Record<string, unknown>>(
    `SELECT ${LIST_COLUMNS}
     FROM request_logs r
     ${whereClause}
     ORDER BY r.created_at DESC
     LIMIT $${String(idx)} OFFSET $${String(idx + 1)}`,
    values,
  );

  const data = dataResult.rows as unknown as RequestLogListItem[];

  logger.debug({ returned: data.length, total, offset, limit }, 'Request logs queried');

  return { data, has_more: offset + data.length < total, total };
}

/**
 * 按 ID 查询请求日志详情（单行点查，允许 JOIN 宽表）
 */
export async function getRequestLogById(id: string): Promise<RequestLogEntry | null> {
  const result = await db.query<Record<string, unknown>>(
    `SELECT ${ENTRY_COLUMNS} FROM request_logs r LEFT JOIN request_log_details d ON r.id = d.id WHERE r.id = $1`,
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
  await db.query(`DELETE FROM request_log_details WHERE id = $1`, [id]);

  const deleted = (result.rowCount ?? 0) > 0;
  if (deleted) {
    logger.info({ requestId: id }, 'Request log deleted');
  }
  return deleted;
}
