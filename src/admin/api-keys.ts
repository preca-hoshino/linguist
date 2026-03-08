// src/admin/api-keys.ts — API Key 管理 CRUD API

import type { Request, Response } from 'express';
import { Router } from 'express';
import { createApiKey, listApiKeys, getApiKeyById, updateApiKey, rotateApiKey, deleteApiKey } from '../db/api-keys';
import { GatewayError, createLogger, logColors } from '../utils';
import { handleError } from '../users/error-formatting';

const logger = createLogger('Admin:ApiKeys', logColors.bold + logColors.blue);

/** 创建/更新请求体类型 */
interface ApiKeyBody {
  name?: string | undefined;
  is_active?: boolean | undefined;
  expires_at?: string | null | undefined;
}

const router = Router();

// ==================== 列出所有 API Key ====================
router.get('/', async (_req: Request, res: Response) => {
  try {
    logger.debug('Listing all API keys');
    const keys = await listApiKeys();
    logger.debug({ count: keys.length }, 'API keys listed');
    res.json(keys);
  } catch (err) {
    handleError(err, res);
  }
});

// ==================== 查询单个 API Key ====================
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    logger.debug({ id }, 'Getting API key by ID');
    const key = await getApiKeyById(id);

    if (!key) {
      throw new GatewayError(404, 'not_found', `API key ${id} not found`);
    }

    res.json(key);
  } catch (err) {
    handleError(err, res);
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

    if (expires_at !== undefined && expires_at !== null) {
      if (typeof expires_at !== 'string' || isNaN(Date.parse(expires_at))) {
        throw new GatewayError(
          400,
          'invalid_request',
          'Field "expires_at" must be a valid ISO 8601 date string or null',
        );
      }
    }

    const result = await createApiKey(name, expires_at ?? undefined);
    logger.info({ id: result.id, name }, 'API key created via admin API');
    res.status(201).json(result);
  } catch (err) {
    handleError(err, res);
  }
});

// ==================== 更新 API Key ====================
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    const body = req.body as ApiKeyBody;
    const { name, is_active, expires_at } = body;
    logger.debug({ id }, 'Updating API key');

    if (name === undefined && is_active === undefined && expires_at === undefined) {
      throw new GatewayError(400, 'invalid_request', 'No fields to update');
    }

    if (expires_at !== undefined && expires_at !== null) {
      if (typeof expires_at !== 'string' || isNaN(Date.parse(expires_at))) {
        throw new GatewayError(
          400,
          'invalid_request',
          'Field "expires_at" must be a valid ISO 8601 date string or null',
        );
      }
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
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

// ==================== 轮换 API Key ====================
router.post('/:id/rotate', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    logger.debug({ id }, 'Rotating API key');
    const result = await rotateApiKey(id);

    if (!result) {
      throw new GatewayError(404, 'not_found', `API key ${id} not found`);
    }

    logger.info({ id }, 'API key rotated via admin API');
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

// ==================== 删除 API Key ====================
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params['id'] as string;
    logger.debug({ id }, 'Deleting API key');
    const deleted = await deleteApiKey(id);

    if (!deleted) {
      throw new GatewayError(404, 'not_found', `API key ${id} not found`);
    }

    logger.info({ id }, 'API key deleted via admin API');
    res.json({ deleted: true, id });
  } catch (err) {
    handleError(err, res);
  }
});

export default router;
