// src/admin/mcp-virtual-servers.ts — Virtual MCP Servers CRUD API

import type { Request, Response } from 'express';
import { Router } from 'express';
import {
  createMcpVirtualServer,
  deleteMcpVirtualServer,
  getMcpVirtualServerById,
  listMcpVirtualServers,
  updateMcpVirtualServer,
} from '@/db/mcp-virtual-servers/queries';
import type { McpVirtualServerCreateInput, McpVirtualServerUpdateInput } from '@/db/mcp-virtual-servers/types';
import { GatewayError } from '@/utils';
import { handleAdminError } from './error';

const router: Router = Router();

// ==================== 列出所有虚拟 MCP ====================
router.get('/', async (req: Request, res: Response) => {
  try {
    const { search, limit, offset, is_active, mcp_provider_id } = req.query;

    const limitNum = typeof limit === 'string' && limit !== '' ? Math.min(Number.parseInt(limit, 10), 100) : 10;
    const offsetNum = typeof offset === 'string' && offset !== '' ? Number.parseInt(offset, 10) : 0;
    const isActiveParsed = typeof is_active === 'string' ? is_active === 'true' : undefined;

    const opts: Parameters<typeof listMcpVirtualServers>[0] = { limit: limitNum, offset: offsetNum };
    if (typeof search === 'string') {
      opts.search = search;
    }
    if (isActiveParsed !== undefined) {
      opts.is_active = isActiveParsed;
    }
    if (typeof mcp_provider_id === 'string') {
      opts.mcp_provider_id = mcp_provider_id;
    }

    const { data, has_more, total } = await listMcpVirtualServers(opts);

    res.json({ object: 'list', data, total, has_more });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 查询单个虚拟 MCP ====================
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const virtualServer = await getMcpVirtualServerById(id);

    if (!virtualServer) {
      throw new GatewayError(404, 'not_found', `Virtual MCP ${id} not found`);
    }

    res.json({ object: 'mcp_virtual_server', ...virtualServer });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 创建虚拟 MCP ====================
router.post('/', async (req: Request, res: Response) => {
  try {
    const body = req.body as McpVirtualServerCreateInput;
    if (
      typeof body.name !== 'string' ||
      body.name === '' ||
      typeof body.mcp_provider_id !== 'string' ||
      body.mcp_provider_id === ''
    ) {
      throw new GatewayError(400, 'invalid_request', 'Fields name, mcp_provider_id are required');
    }

    const created = await createMcpVirtualServer(body);
    res.status(201).json({ object: 'mcp_virtual_server', ...created });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 更新虚拟 MCP ====================
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const body = req.body as McpVirtualServerUpdateInput;

    const updated = await updateMcpVirtualServer(id, body);
    if (!updated) {
      throw new GatewayError(404, 'not_found', `Virtual MCP ${id} not found or no fields to update`);
    }

    res.json({ object: 'mcp_virtual_server', ...updated });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 删除虚拟 MCP ====================
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const success = await deleteMcpVirtualServer(id);

    if (!success) {
      throw new GatewayError(404, 'not_found', `Virtual MCP ${id} not found`);
    }

    res.json({ id, object: 'mcp_virtual_server', deleted: true });
  } catch (error) {
    handleAdminError(error, res);
  }
});

export { router as mcpVirtualServersRouter };
