// src/admin/request-logs.ts — 请求日志管理 API

import type { Request, Response } from 'express';
import { Router } from 'express';
import type { RequestLogStatus } from '@/db';
import { deleteRequestLogById, deleteRequestLogsBatch, getRequestLogById, queryRequestLogs } from '@/db';
import { createLogger, GatewayError, logColors } from '@/utils';
import { handleAdminError } from './error';

const logger = createLogger('Admin:RequestLogs', logColors.bold + logColors.blue);

const router: Router = Router();

const VALID_STATUSES: RequestLogStatus[] = ['processing', 'completed', 'error'];

// ==================== 批量删除请求日志 ====================
// POST /admin/request-logs/batch-delete
router.post('/batch-delete', async (req: Request, res: Response) => {
  try {
    const { ids } = req.body as { ids: string[] };
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new GatewayError(400, 'invalid_request', 'Missing or invalid "ids" array in request body');
    }

    logger.debug({ count: ids.length }, 'Batch deleting request logs');
    const deletedCount = await deleteRequestLogsBatch(ids);

    logger.debug({ deletedCount }, 'Batch request logs deleted');
    res.json({ object: 'batch_delete', deleted_count: deletedCount, requested_count: ids.length });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 查询请求日志列表 ====================
// GET /admin/request-logs?status=completed&request_model=deepseek-chat&provider_kind=deepseek&error_type=rate_limit&limit=50&offset=0
router.get('/', async (req: Request, res: Response) => {
  try {
    const {
      status,
      request_model,
      provider_kind,
      provider_id,
      error_type,
      api_key_prefix,
      user_format,
      is_stream,
      app_id,
      limit,
      starting_after,
    } = req.query;
    logger.debug(
      {
        status,
        request_model,
        provider_kind,
        provider_id,
        error_type,
        api_key_prefix,
        user_format,
        is_stream,
        app_id,
        limit,
        starting_after,
      },
      'Querying request logs',
    );

    // 校验 status
    if (typeof status === 'string' && status !== '' && !VALID_STATUSES.includes(status as RequestLogStatus)) {
      throw new GatewayError(
        400,
        'invalid_status',
        `Invalid status filter. Valid values: ${VALID_STATUSES.join(', ')}`,
      );
    }

    const limitNum = typeof limit === 'string' && limit !== '' ? Number.parseInt(limit, 10) : undefined;
    const startingAfter = typeof starting_after === 'string' && starting_after !== '' ? starting_after : undefined;

    const result = await queryRequestLogs({
      status: typeof status === 'string' && status !== '' ? (status as RequestLogStatus) : undefined,
      request_model: typeof request_model === 'string' && request_model !== '' ? request_model : undefined,
      provider_kind: typeof provider_kind === 'string' && provider_kind !== '' ? provider_kind : undefined,
      provider_id: typeof provider_id === 'string' && provider_id !== '' ? provider_id : undefined,
      error_type: typeof error_type === 'string' && error_type !== '' ? error_type : undefined,
      api_key_prefix: typeof api_key_prefix === 'string' && api_key_prefix !== '' ? api_key_prefix : undefined,
      user_format: typeof user_format === 'string' && user_format !== '' ? user_format : undefined,
      is_stream: typeof is_stream === 'string' && is_stream !== '' ? is_stream === 'true' : undefined,
      app_id: typeof app_id === 'string' && app_id !== '' ? app_id : undefined,
      limit: limitNum,
      starting_after: startingAfter,
    });

    logger.debug({ returned: result.data.length, has_more: result.has_more }, 'Request logs queried');
    res.json({ object: 'list', data: result.data, has_more: result.has_more });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 查询单条请求日志详情（含完整请求/响应体） ====================
// GET /admin/request-logs/:id
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    logger.debug({ id }, 'Getting request log detail');
    const log = await getRequestLogById(id);

    if (!log) {
      throw new GatewayError(404, 'not_found', `Request log ${id} not found`);
    }

    logger.debug({ id }, 'Request log detail fetched');
    res.json({ object: 'request_log', ...log });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 删除单条请求日志 ====================
// DELETE /admin/request-logs/:id
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    logger.debug({ id }, 'Deleting request log');
    const deleted = await deleteRequestLogById(id);

    if (!deleted) {
      throw new GatewayError(404, 'not_found', `Request log ${id} not found`);
    }

    logger.debug({ id }, 'Request log deleted');
    res.json({ id, object: 'request_log', deleted: true });
  } catch (error) {
    handleAdminError(error, res);
  }
});

export { router as requestLogsRouter };
