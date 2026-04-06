// src/admin/api-keys.ts — API Key 管理 CRUD API

import type { Request, Response } from 'express';
import { Router } from 'express';
import { createApiKey, deleteApiKey, getApiKeyById, listApiKeys, rotateApiKey, updateApiKey } from '@/db/api-keys';
import { createLogger, GatewayError, logColors } from '@/utils';
import { handleAdminError } from './error';

const logger = createLogger('Admin:ApiKeys', logColors.bold + logColors.blue);

/** 创建/更新请求体类型 */
interface ApiKeyBody {
  name?: string | undefined;
  is_active?: boolean | undefined;
  expires_at?: string | null | undefined;
}

const router: Router = Router();

// ==================== 列出所有 API Key ====================
router.get('/', async (req: Request, res: Response) => {
  try {
    const { search, limit, offset } = req.query;
    const limitNum = typeof limit === 'string' && limit !== '' ? Math.min(Number.parseInt(limit, 10), 100) : 10;
    const offsetNum = typeof offset === 'string' && offset !== '' ? Number.parseInt(offset, 10) : 0;
    const searchStr = typeof search === 'string' ? search : undefined;

    logger.debug({ search: searchStr, limit: limitNum, offset: offsetNum }, 'Listing all API keys');

    const { data: keys, total } = await listApiKeys({
      limit: limitNum,
      offset: offsetNum,
      ...(searchStr === undefined ? {} : { search: searchStr }),
    });

    const data = keys.map((k) => ({ object: 'api_key', ...k }));
    const hasMore = offsetNum + data.length < total;

    logger.debug({ count: data.length, total, has_more: hasMore }, 'API keys listed');
    res.json({ object: 'list', data, total, has_more: hasMore });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 查询单个 API Key ====================
router.get('/:id', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const id = req.params.id;

    logger.debug({ id }, 'Getting API key by ID');
    const key = await getApiKeyById(id);

    if (!key) {
      throw new GatewayError(404, 'not_found', `API key ${id} not found`);
    }

    res.json({ object: 'api_key', ...key });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 创建 API Key ====================
router.post('/', async (req: Request, res: Response) => {
  try {
    const body = req.body as ApiKeyBody;
    const { name, expires_at } = body;
    logger.debug({ name, expiresAt: expires_at }, 'Creating API key');

    if (typeof name !== 'string' || name === '') {
      throw new GatewayError(400, 'invalid_request', 'Field "name" is required and must be a non-empty string');
    }

    if (
      expires_at !== undefined &&
      expires_at !== null &&
      (typeof expires_at !== 'string' || Number.isNaN(Date.parse(expires_at)))
    ) {
      throw new GatewayError(400, 'invalid_request', 'Field "expires_at" must be a valid ISO 8601 date string or null');
    }

    const result = await createApiKey(name, expires_at ?? undefined);
    logger.info({ id: result.id, name }, 'API key created via admin API');
    res.status(201).json({ object: 'api_key', ...result });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 更新 API Key ====================
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const body = req.body as ApiKeyBody;
    const { name, is_active, expires_at } = body;
    logger.debug({ id }, 'Updating API key');

    if (name === undefined && is_active === undefined && expires_at === undefined) {
      throw new GatewayError(400, 'invalid_request', 'No fields to update');
    }

    if (
      expires_at !== undefined &&
      expires_at !== null &&
      (typeof expires_at !== 'string' || Number.isNaN(Date.parse(expires_at)))
    ) {
      throw new GatewayError(400, 'invalid_request', 'Field "expires_at" must be a valid ISO 8601 date string or null');
    }

    const result = await updateApiKey(id, {
      name: name,
      is_active: is_active,
      expires_at: expires_at,
    });

    if (!result) {
      throw new GatewayError(404, 'not_found', `API key ${id} not found`);
    }

    logger.info({ id }, 'API key updated via admin API');
    res.json({ object: 'api_key', ...result });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 轮换 API Key ====================
router.post('/:id/rotate', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    logger.debug({ id }, 'Rotating API key');
    const result = await rotateApiKey(id);

    if (!result) {
      throw new GatewayError(404, 'not_found', `API key ${id} not found`);
    }

    logger.info({ id }, 'API key rotated via admin API');
    res.json({ object: 'api_key', ...result });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 删除 API Key ====================
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    logger.debug({ id }, 'Deleting API key');
    const deleted = await deleteApiKey(id);

    if (!deleted) {
      throw new GatewayError(404, 'not_found', `API key ${id} not found`);
    }

    logger.info({ id }, 'API key deleted via admin API');
    res.json({ id, object: 'api_key', deleted: true });
  } catch (error) {
    handleAdminError(error, res);
  }
});

export { router as apiKeysRouter };
