// src/admin/mcp-virtual-servers.ts — Virtual MCPs CRUD API

import type { Request, Response } from 'express';
import { Router } from 'express';
import {
  createVirtualMcp,
  deleteVirtualMcp,
  getVirtualMcpById,
  listVirtualMcps,
  updateVirtualMcp,
} from '@/db/mcp-virtual-servers/queries';
import type { VirtualMcpCreateInput, VirtualMcpUpdateInput } from '@/db/mcp-virtual-servers/types';
import { GatewayError } from '@/utils';
import { handleAdminError } from './error';

const router: Router = Router();

/** 虚拟 MCP 名字只允许字母、数字、连字符、下划线、点，不允许空格 */
const MCP_NAME_REGEX = /^[a-zA-Z0-9._-]+$/;
const MCP_NAME_FORMAT_ERROR =
  'Name must not contain spaces. Only letters, numbers, hyphens (-), underscores (_), and dots (.) are allowed.';

// ==================== 列出所有虚拟 MCP ====================
router.get('/', async (req: Request, res: Response) => {
  try {
    const { search, limit, offset, is_active, mcp_provider_id } = req.query;

    const limitNum = typeof limit === 'string' && limit !== '' ? Math.min(Number.parseInt(limit, 10), 100) : 10;
    const offsetNum = typeof offset === 'string' && offset !== '' ? Number.parseInt(offset, 10) : 0;
    const isActiveParsed = typeof is_active === 'string' ? is_active === 'true' : undefined;

    const opts: Parameters<typeof listVirtualMcps>[0] = { limit: limitNum, offset: offsetNum };
    if (typeof search === 'string') {
      opts.search = search;
    }
    if (isActiveParsed !== undefined) {
      opts.is_active = isActiveParsed;
    }
    if (typeof mcp_provider_id === 'string') {
      opts.mcp_provider_id = mcp_provider_id;
    }

    const { data, has_more, total } = await listVirtualMcps(opts);

    res.json({ object: 'list', data, total, has_more });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 查询单个虚拟 MCP ====================
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const virtualMcp = await getVirtualMcpById(id);

    if (!virtualMcp) {
      throw new GatewayError(404, 'not_found', `Virtual MCP ${id} not found`);
    }

    res.json({ object: 'virtual_mcp', ...virtualMcp });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 创建虚拟 MCP ====================
router.post('/', async (req: Request, res: Response) => {
  try {
    const body = req.body as VirtualMcpCreateInput;
    if (
      typeof body.name !== 'string' ||
      body.name === '' ||
      typeof body.mcp_provider_id !== 'string' ||
      body.mcp_provider_id === ''
    ) {
      throw new GatewayError(400, 'invalid_request', 'Fields name, mcp_provider_id are required');
    }

    if (!MCP_NAME_REGEX.test(body.name)) {
      throw new GatewayError(400, 'invalid_request', MCP_NAME_FORMAT_ERROR);
    }

    const created = await createVirtualMcp(body);
    res.status(201).json({ object: 'virtual_mcp', ...created });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 更新虚拟 MCP ====================
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const body = req.body as VirtualMcpUpdateInput;

    // 若包含 name 字段，校验格式（不允许空格）
    if (typeof body.name === 'string' && body.name !== '' && !MCP_NAME_REGEX.test(body.name)) {
      throw new GatewayError(400, 'invalid_request', MCP_NAME_FORMAT_ERROR);
    }

    const updated = await updateVirtualMcp(id, body);
    if (!updated) {
      throw new GatewayError(404, 'not_found', `Virtual MCP ${id} not found or no fields to update`);
    }

    res.json({ object: 'virtual_mcp', ...updated });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 删除虚拟 MCP ====================
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const success = await deleteVirtualMcp(id);

    if (!success) {
      throw new GatewayError(404, 'not_found', `Virtual MCP ${id} not found`);
    }

    res.json({ id, object: 'virtual_mcp', deleted: true });
  } catch (error) {
    handleAdminError(error, res);
  }
});

export { router as mcpVirtualServersRouter };
