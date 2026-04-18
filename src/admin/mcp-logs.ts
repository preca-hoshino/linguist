// src/admin/mcp-logs.ts — MCP Logs API

import type { Request, Response } from 'express';
import { Router } from 'express';
import { getMcpLogById, listMcpLogs, deleteMcpLogsBatch } from '@/db/mcp-logs/queries';
import { GatewayError } from '@/utils';
import { handleAdminError } from './error';

const router: Router = Router();

// ==================== 批量删除 MCP 日志 ====================
// POST /admin/mcp-logs/batch-delete
router.post('/batch-delete', async (req: Request, res: Response) => {
  try {
    const { ids } = req.body as { ids: string[] };
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new GatewayError(400, 'invalid_request', 'Missing or invalid "ids" array in request body');
    }

    const deletedCount = await deleteMcpLogsBatch(ids);
    res.json({ object: 'batch_delete', deleted_count: deletedCount, requested_count: ids.length });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 列出所有 MCP 日志 ====================
router.get('/', async (req: Request, res: Response) => {
  try {
    const { limit, offset, virtual_mcp_id, mcp_provider_id, method, direction } = req.query;

    const limitNum = typeof limit === 'string' && limit !== '' ? Math.min(Number.parseInt(limit, 10), 100) : 20;
    const offsetNum = typeof offset === 'string' && offset !== '' ? Number.parseInt(offset, 10) : 0;

    const opts: Parameters<typeof listMcpLogs>[0] = { limit: limitNum, offset: offsetNum };
    if (typeof virtual_mcp_id === 'string') {
      opts.virtual_mcp_id = virtual_mcp_id;
    }
    if (typeof mcp_provider_id === 'string') {
      opts.mcp_provider_id = mcp_provider_id;
    }
    if (typeof method === 'string') {
      opts.method = method;
    }
    if (typeof direction === 'string') {
      opts.direction = direction;
    }

    const { data, has_more, total } = await listMcpLogs(opts);

    res.json({ object: 'list', data, total, has_more });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 查询单个 MCP 日志详情 ====================
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const logResult = await getMcpLogById(id);

    if (!logResult) {
      throw new GatewayError(404, 'not_found', `MCP Log ${id} not found`);
    }

    res.json({ object: 'mcp_log', ...logResult });
  } catch (error) {
    handleAdminError(error, res);
  }
});

export { router as mcpLogsRouter };
