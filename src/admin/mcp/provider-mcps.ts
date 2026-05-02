// src/admin/mcp-providers.ts — MCP Providers CRUD API

import type { Request, Response } from 'express';
import { Router } from 'express';
import {
  createMcpProvider,
  deleteMcpProvider,
  getMcpProviderById,
  listMcpProviders,
  updateMcpProvider,
} from '@/db/mcp-providers/queries';
import type { McpProviderCreateInput, McpProviderUpdateInput } from '@/db/mcp-providers/types';
import type { McpToolInfo } from '@/mcp/providers/base-client';
import { mcpConnectionManager } from '@/mcp/providers/connection-manager';
import { GatewayError } from '@/utils';
import { handleAdminError } from '../error';
import { validateMetadata } from '../metadata-validator';

const router: Router = Router();

// ==================== 列出所有提供商 MCP ====================
router.get('/', async (req: Request, res: Response) => {
  try {
    const { search, limit, offset, is_active, kind } = req.query;

    const limitNum =
      typeof limit === 'string' && limit !== '' ? Math.min(Math.max(Number.parseInt(limit, 10), 1), 100) : 10;
    const offsetNum = typeof offset === 'string' && offset !== '' ? Math.max(Number.parseInt(offset, 10), 0) : 0;
    const isActiveParsed = typeof is_active === 'string' ? is_active === 'true' : undefined;

    const opts: Parameters<typeof listMcpProviders>[0] = { limit: limitNum, offset: offsetNum };
    if (typeof search === 'string') {
      opts.search = search;
    }
    if (isActiveParsed !== undefined) {
      opts.is_active = isActiveParsed;
    }
    if (typeof kind === 'string') {
      opts.kind = kind;
    }

    const { data, has_more, total } = await listMcpProviders(opts);

    res.json({ object: 'list', url: '/admin/mcp/provider-mcps', data, total, has_more });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 查询单个提供商 MCP 的工具集 ====================
router.get('/:id/tools', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const provider = await getMcpProviderById(id);

    if (!provider) {
      throw new GatewayError(404, 'not_found', `MCP Provider ${id} not found`);
    }

    let toolsResult: McpToolInfo[];
    try {
      const client = await mcpConnectionManager.getClient(provider);
      toolsResult = await client.listTools();
    } catch (err: unknown) {
      if (err instanceof GatewayError) {
        throw err;
      }
      if (err instanceof Error) {
        throw new GatewayError(
          502,
          'provider_connection_failed',
          `Failed to connect to or query MCP provider: ${err.message}`,
        );
      }
      throw err;
    }

    res.json({ object: 'list', data: toolsResult });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 查询单个提供商 MCP ====================
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const provider = await getMcpProviderById(id);

    if (!provider) {
      throw new GatewayError(404, 'not_found', `MCP Provider ${id} not found`);
    }

    res.json({ object: 'mcp_provider', ...provider });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 创建提供商 MCP ====================
router.post('/', async (req: Request, res: Response) => {
  try {
    const body = req.body as McpProviderCreateInput;
    if (
      typeof body.name !== 'string' ||
      body.name === '' ||
      typeof body.kind !== 'string' ||
      (body.kind as unknown as string) === ''
    ) {
      throw new GatewayError(400, 'invalid_request', 'Fields name, kind are required');
    }

    validateMetadata(body.metadata);

    const created = await createMcpProvider(body);
    res.status(201).json({ object: 'mcp_provider', ...created });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 更新提供商 MCP ====================
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const body = req.body as McpProviderUpdateInput;

    validateMetadata(body.metadata);

    const updated = await updateMcpProvider(id, body);
    if (!updated) {
      throw new GatewayError(404, 'not_found', `MCP Provider ${id} not found or no fields to update`);
    }

    res.json({ object: 'mcp_provider', ...updated });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 删除提供商 MCP ====================
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const success = await deleteMcpProvider(id);

    if (!success) {
      throw new GatewayError(404, 'not_found', `MCP Provider ${id} not found`);
    }

    res.json({ id, object: 'mcp_provider', deleted: true });
  } catch (error) {
    handleAdminError(error, res);
  }
});

export { router as mcpProvidersRouter };
