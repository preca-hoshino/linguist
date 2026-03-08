// src/admin/request-logs.ts — 请求日志管理 API

import type { Request, Response } from 'express';
import { Router } from 'express';
import { GatewayError, createLogger, logColors } from '../utils';
import { handleError } from '../users/error-formatting';
import type { RequestLogStatus } from '../db';
import { queryRequestLogs, getRequestLogById, deleteRequestLogById } from '../db';

const logger = createLogger('Admin:RequestLogs', logColors.bold + logColors.blue);

const router = Router();

const VALID_STATUSES: RequestLogStatus[] = ['processing', 'completed', 'error'];

// ==================== 查询请求日志列表 ====================
// GET /admin/request-logs?status=completed&request_model=deepseek-chat&provider_kind=deepseek&error_type=rate_limit&limit=50&offset=0
router.get('/', async (req: Request, res: Response) => {
  try {
    const { status, request_model, provider_kind, error_type, api_key_prefix, is_stream, limit, offset } = req.query;
    logger.debug(
      { status, request_model, provider_kind, error_type, api_key_prefix, is_stream, limit, offset },
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

    const result = await queryRequestLogs({
      status: typeof status === 'string' && status !== '' ? (status as RequestLogStatus) : undefined,
      request_model: typeof request_model === 'string' && request_model !== '' ? request_model : undefined,
      provider_kind: typeof provider_kind === 'string' && provider_kind !== '' ? provider_kind : undefined,
      error_type: typeof error_type === 'string' && error_type !== '' ? error_type : undefined,
      api_key_prefix: typeof api_key_prefix === 'string' && api_key_prefix !== '' ? api_key_prefix : undefined,
      is_stream: typeof is_stream === 'string' && is_stream !== '' ? is_stream === 'true' : undefined,
      limit: typeof limit === 'string' && limit !== '' ? parseInt(limit, 10) : undefined,
      offset: typeof offset === 'string' && offset !== '' ? parseInt(offset, 10) : undefined,
    });

    logger.debug({ total: result.total, returned: result.data.length }, 'Request logs queried');
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

// ==================== 查询单条请求日志详情（含完整请求/响应体） ====================
// GET /admin/request-logs/:id
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    logger.debug({ id }, 'Getting request log detail');
    const log = await getRequestLogById(id);

    if (!log) {
      throw new GatewayError(404, 'not_found', `Request log ${id} not found`);
    }

    logger.debug({ id }, 'Request log detail fetched');
    res.json(log);
  } catch (err) {
    handleError(err, res);
  }
});

// ==================== 删除单条请求日志 ====================
// DELETE /admin/request-logs/:id
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    logger.debug({ id }, 'Deleting request log');
    const deleted = await deleteRequestLogById(id);

    if (!deleted) {
      throw new GatewayError(404, 'not_found', `Request log ${id} not found`);
    }

    logger.debug({ id }, 'Request log deleted');
    res.status(204).send();
  } catch (err) {
    handleError(err, res);
  }
});

export default router;
