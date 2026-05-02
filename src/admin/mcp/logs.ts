// src/admin/mcp/logs.ts — MCP Logs API

import type { Request, Response } from 'express';
import { Router } from 'express';
import { deleteMcpLogById, getMcpLogById, listMcpLogs } from '@/db/mcp-logs/queries';
import type { McpLogQuery } from '@/db/mcp-logs/types';
import { GatewayError } from '@/utils';
import { handleAdminError } from '../error';

const router: Router = Router();

// ==================== 列出所有 MCP 日志 ====================
router.get('/', async (req: Request, res: Response) => {
  try {
    const { limit, offset, virtual_mcp_id, mcp_provider_id, method, status, tool_name } = req.query;

    const limitNum = typeof limit === 'string' && limit !== '' ? Math.min(Number.parseInt(limit, 10), 100) : 20;
    const offsetNum = typeof offset === 'string' && offset !== '' ? Number.parseInt(offset, 10) : 0;

    const opts: McpLogQuery = { limit: limitNum, offset: offsetNum };
    if (typeof virtual_mcp_id === 'string' && virtual_mcp_id !== '') {
      opts.virtual_mcp_id = virtual_mcp_id;
    }
    if (typeof mcp_provider_id === 'string' && mcp_provider_id !== '') {
      opts.mcp_provider_id = mcp_provider_id;
    }
    if (typeof method === 'string' && method !== '') {
      opts.method = method;
    }
    if (typeof status === 'string' && status !== '') {
      if (status === 'processing' || status === 'completed' || status === 'error') {
        opts.status = status;
      }
    }
    if (typeof tool_name === 'string' && tool_name !== '') {
      opts.tool_name = tool_name;
    }

    const { data, has_more, total } = await listMcpLogs(opts);

    res.json({ object: 'list', url: '/admin/mcp/logs', data, total, has_more });
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

// ==================== 删除单条 MCP 日志 ====================
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const deleted = await deleteMcpLogById(id);

    if (!deleted) {
      throw new GatewayError(404, 'not_found', `MCP Log ${id} not found`);
    }

    res.json({ id, object: 'mcp_log', deleted: true });
  } catch (error) {
    handleAdminError(error, res);
  }
});

export { router as mcpLogsRouter };
