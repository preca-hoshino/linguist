// src/db/request-logs/read.ts — 请求日志查询操作

import { db } from '@/db/client';
import { createLogger, logColors } from '@/utils';
import type { RequestLogEntry, RequestLogQuery } from './types';
import { ENTRY_COLUMNS } from './types';

const logger = createLogger('RequestLog', logColors.bold + logColors.blue);

/**
 * 查询请求日志列表（含 gateway_context 完整快照）
 *
 * 优化：使用 Deferred Join（延迟主键关联）以在深度分页下依然维持极速扫描。
 * 针对 total 执行被限流/截断的安全策略避免由于全表扫描瘫痪数据库。
 */
export async function queryRequestLogs(query: RequestLogQuery = {}): Promise<{
  data: RequestLogEntry[];
  total: number;
}> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  let baseFrom = 'request_logs r';

  if (query.status !== undefined) {
    conditions.push(`r.status = $${String(idx++)}`);
    values.push(query.status);
  }
  if (query.request_model !== undefined && query.request_model !== '') {
    // 利用 pg_trgm
    conditions.push(`r.request_model ILIKE $${String(idx++)}`);
    values.push(`%${query.request_model}%`);
  }
  if (query.provider_kind !== undefined && query.provider_kind !== '') {
    conditions.push(`r.provider_kind = $${String(idx++)}`);
    values.push(query.provider_kind);
  }
  if (query.provider_id !== undefined && query.provider_id !== '') {
    conditions.push(`r.provider_id = $${String(idx++)}`);
    values.push(query.provider_id);
  }
  if (query.error_type !== undefined && query.error_type !== '') {
    conditions.push(`r.error_type = $${String(idx++)}`);
    values.push(query.error_type);
  }
  if (query.api_key_prefix !== undefined && query.api_key_prefix !== '') {
    conditions.push(`r.api_key_prefix = $${String(idx++)}`);
    values.push(query.api_key_prefix);
  }
  if (query.user_format !== undefined && query.user_format !== '') {
    // 若查询包含了独立的冷数据部分，临时改变主驱动表关联
    baseFrom = 'request_logs r INNER JOIN request_logs_details d ON r.id = d.id';
    conditions.push(`d.gateway_context->>'userFormat' = $${String(idx++)}`);
    values.push(query.user_format);
  }
  if (query.is_stream !== undefined) {
    conditions.push(`r.is_stream = $${String(idx++)}`);
    values.push(query.is_stream);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // ----------------------------------------------------
  // 黑科技：Hyper-Fast Hybrid Pagination (毫秒级混合分页引擎)
  // 对于查询海量数据采用纯估算保证毫秒极速，浅层精确查询秒回真实全貌
  // ----------------------------------------------------
  let total = 0;
  try {
    // 1. 拦截优化执行计划，秒速探测数据池深度（耗时 < 1ms）
    const explainSql = `EXPLAIN (FORMAT JSON) SELECT 1 FROM ${baseFrom} ${whereClause}`;
    const explainResult = await db.query(explainSql, values);

    const row0 = explainResult.rows[0];
    const queryPlan = row0 ? (row0['QUERY PLAN'] as unknown[] | undefined) : undefined;
    const planObj = queryPlan ? (queryPlan[0] as Record<string, unknown> | undefined) : undefined;
    const plan = planObj ? (planObj.Plan as Record<string, unknown> | undefined) : undefined;
    const planRows = Number(plan?.['Plan Rows']) || 0;

    if (planRows > 50_000) {
      // 2. 深水区：当数据可能突破五万甚至千万级别，执行 EXACT COUNT 将毁灭响应速度，直接下发高精估算值
      total = Math.round(planRows);
    } else {
      // 3. 浅水区 / 强过滤检索：此时真实数量查起来如脱缰野马，返回宇宙级 100% 精确条数用于分页
      const countResult = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM ${baseFrom} ${whereClause}`,
        values,
      );
      total = countResult.rows[0] ? Number.parseInt(countResult.rows[0].count, 10) : 0;
    }
  } catch (error) {
    // 兜底防御：退化回 5 万硬封顶计数
    logger.error({ err: error }, 'Hybrid count failed, falling back limit count');
    const countFallback = await db.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM (SELECT 1 FROM ${baseFrom} ${whereClause} LIMIT 50000) as t`,
      values,
    );
    total = countFallback.rows[0] ? Number.parseInt(countFallback.rows[0].count, 10) : 0;
  }

  // 查数据（追加分页参数，采用 Deferred Join 仅对所需数据块进行回表连接！）
  const limit = Math.min(query.limit ?? 50, 200);
  const offset = query.offset ?? 0;
  const dataValues = [...values, limit, offset];

  const dataResult = await db.query<Record<string, unknown>>(
    `SELECT ${ENTRY_COLUMNS}
     FROM (
       SELECT r.id 
       FROM ${baseFrom} 
       ${whereClause}
       ORDER BY r.created_at DESC
       LIMIT $${String(idx)} OFFSET $${String(idx + 1)}
     ) AS pointer
     JOIN request_logs r ON pointer.id = r.id
     LEFT JOIN request_logs_details d ON pointer.id = d.id
     ORDER BY r.created_at DESC`,
    dataValues,
  );

  return { data: dataResult.rows as unknown as RequestLogEntry[], total };
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

/**
 * 批量删除请求日志
 */
export async function deleteRequestLogsBatch(ids: string[]): Promise<number> {
  if (ids.length === 0) {
    return 0;
  }
  // 使用 ANY 提升批量性能，同时兼顾 details 详情表的清洗
  const result = await db.query(`DELETE FROM request_logs WHERE id = ANY($1::varchar[])`, [ids]);
  await db.query(`DELETE FROM request_logs_details WHERE id = ANY($1::varchar[])`, [ids]);

  const deletedCount = result.rowCount ?? 0;
  if (deletedCount > 0) {
    logger.info({ count: deletedCount }, 'Batch request logs deleted');
  }
  return deletedCount;
}
