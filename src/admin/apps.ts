// src/admin/apps.ts — 应用（App）管理 API（Stripe 风格）
// 嵌套资源：Apps + Keys，游标分页，POST 更新

import type { Request, Response } from 'express';
import { Router } from 'express';
import { createApiKey, deleteApiKey, getApiKeyById, listApiKeys, rotateApiKey, updateApiKey } from '@/db/api-keys';
import { createApp, deleteApp, getAppById, listApps, updateApp } from '@/db/apps';
import { createLogger, GatewayError, logColors } from '@/utils';
import { handleAdminError } from './error';

const logger = createLogger('Admin:Apps', logColors.bold + logColors.blue);

const router: Router = Router();

// ====================================================================
//  应用（App）CRUD
// ====================================================================

// ==================== 列出应用（游标分页） ====================
// GET /api/apps?limit=10&starting_after=abc123&search=xxx
router.get('/', async (req: Request, res: Response) => {
  try {
    const { limit, starting_after, search, is_active } = req.query;
    const limitNum = typeof limit === 'string' && limit !== '' ? Math.min(Number.parseInt(limit, 10), 100) : undefined;
    const startingAfter = typeof starting_after === 'string' ? starting_after : undefined;
    const searchStr = typeof search === 'string' ? search : undefined;
    const isActiveParam =
      typeof is_active === 'string' && is_active !== '' ? is_active.toLowerCase() === 'true' : undefined;

    logger.debug(
      { search: searchStr, limit: limitNum, starting_after: startingAfter, is_active: isActiveParam },
      'Listing apps',
    );

    const result = await listApps({
      ...(limitNum !== undefined ? { limit: limitNum } : {}),
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
      ...(searchStr !== undefined ? { search: searchStr } : {}),
      ...(isActiveParam !== undefined ? { is_active: isActiveParam } : {}),
    });

    const data = result.data.map((a) => ({ object: 'app' as const, ...a }));

    logger.debug({ count: data.length, has_more: result.has_more, total: result.total }, 'Apps listed');
    res.json({
      object: 'list',
      url: '/api/apps',
      has_more: result.has_more,
      total: result.total,
      data,
    });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 获取应用详情 ====================
// GET /api/apps/:id
router.get('/:id', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const { id } = req.params;
    logger.debug({ id }, 'Getting app by ID');
    const app = await getAppById(id);

    if (!app) {
      throw new GatewayError(404, 'not_found', `App ${id} not found`);
    }

    res.json({ object: 'app', ...app });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 创建应用 ====================
// POST /api/apps
router.post('/', async (req: Request, res: Response) => {
  try {
    const body = req.body as { name?: string; allowed_model_ids?: string[] };
    const { name, allowed_model_ids } = body;

    if (typeof name !== 'string' || name === '') {
      throw new GatewayError(400, 'invalid_request', 'Field "name" is required and must be a non-empty string');
    }

    logger.debug({ name }, 'Creating app');
    const app = await createApp({ name, allowed_model_ids });
    logger.info({ id: app.id, name }, 'App created via admin API');
    res.status(201).json({ object: 'app', ...app });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 更新应用（Stripe 风格：PATCH 局部更新） ====================
// PATCH /api/apps/:id
router.patch('/:id', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const { id } = req.params;
    const body = req.body as { name?: string; is_active?: boolean; allowed_model_ids?: string[] };

    logger.debug({ id }, 'Updating app');
    const app = await updateApp(id, body);

    if (!app) {
      throw new GatewayError(404, 'not_found', `App ${id} not found`);
    }

    logger.info({ id }, 'App updated via admin API');
    res.json({ object: 'app', ...app });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 删除应用 ====================
// DELETE /api/apps/:id
router.delete('/:id', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const { id } = req.params;
    logger.debug({ id }, 'Deleting app');
    const deleted = await deleteApp(id);

    if (!deleted) {
      throw new GatewayError(404, 'not_found', `App ${id} not found`);
    }

    logger.info({ id }, 'App deleted via admin API');
    res.json({ id, object: 'app', deleted: true });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ====================================================================
//  嵌套资源：Keys（App 子资源）
// ====================================================================

// ==================== 创建 Key ====================
// POST /api/apps/:appId/keys
router.post('/:appId/keys', async (req: Request<{ appId: string }>, res: Response) => {
  try {
    const { appId } = req.params;
    const body = req.body as { name?: string; expires_at?: string | null };
    const { name, expires_at } = body;

    if (typeof name !== 'string' || name === '') {
      throw new GatewayError(400, 'invalid_request', 'Field "name" is required and must be a non-empty string');
    }

    // 校验 appId 是否存在
    const app = await getAppById(appId);
    if (!app) {
      throw new GatewayError(404, 'not_found', `App ${appId} not found`);
    }

    if (
      expires_at !== undefined &&
      expires_at !== null &&
      (typeof expires_at !== 'string' || Number.isNaN(Date.parse(expires_at)))
    ) {
      throw new GatewayError(400, 'invalid_request', 'Field "expires_at" must be a valid ISO 8601 date string or null');
    }

    logger.debug({ appId, name }, 'Creating key for app');
    const key = await createApiKey(appId, name, expires_at ?? undefined);
    logger.info({ appId, keyId: key.id, name }, 'Key created via admin API');
    res.status(201).json({ object: 'api_key', ...key });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 列出 Keys ====================
// GET /api/apps/:appId/keys
router.get('/:appId/keys', async (req: Request<{ appId: string }>, res: Response) => {
  try {
    const { appId } = req.params;
    const { limit, starting_after, search } = req.query;

    const limitNum = typeof limit === 'string' && limit !== '' ? Math.min(Number.parseInt(limit, 10), 100) : 10;
    const startingAfterStr = typeof starting_after === 'string' ? starting_after.trim() : undefined;
    const searchStr = typeof search === 'string' ? search : undefined;

    logger.debug({ appId, limit: limitNum, starting_after: startingAfterStr }, 'Listing keys for app');
    const {
      data: keys,
      total,
      has_more,
    } = await listApiKeys({
      appId,
      limit: limitNum,
      ...(startingAfterStr !== undefined ? { starting_after: startingAfterStr } : {}),
      ...(searchStr !== undefined ? { search: searchStr } : {}),
    });

    const data = keys.map((k) => ({ object: 'api_key' as const, ...k }));

    res.json({
      object: 'list',
      url: `/api/apps/${appId}/keys`,
      has_more,
      total,
      data,
    });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 获取 Key 详情 ====================
// GET /api/apps/:appId/keys/:keyId
router.get('/:appId/keys/:keyId', async (req: Request<{ appId: string; keyId: string }>, res: Response) => {
  try {
    const { keyId } = req.params;
    logger.debug({ keyId }, 'Getting key by ID');
    const key = await getApiKeyById(keyId);

    if (!key) {
      throw new GatewayError(404, 'not_found', `API key ${keyId} not found`);
    }

    res.json({ object: 'api_key', ...key });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 更新 Key（Stripe: PATCH 局部更新） ====================
// PATCH /api/apps/:appId/keys/:keyId
router.patch('/:appId/keys/:keyId', async (req: Request<{ appId: string; keyId: string }>, res: Response) => {
  try {
    const { keyId } = req.params;
    const body = req.body as { name?: string; is_active?: boolean; expires_at?: string | null };

    logger.debug({ keyId }, 'Updating key');
    const result = await updateApiKey(keyId, body);

    if (!result) {
      throw new GatewayError(404, 'not_found', `API key ${keyId} not found`);
    }

    logger.info({ keyId }, 'Key updated via admin API');
    res.json({ object: 'api_key', ...result });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 删除 Key ====================
// DELETE /api/apps/:appId/keys/:keyId
router.delete('/:appId/keys/:keyId', async (req: Request<{ appId: string; keyId: string }>, res: Response) => {
  try {
    const { keyId } = req.params;
    logger.debug({ keyId }, 'Deleting key');
    const deleted = await deleteApiKey(keyId);

    if (!deleted) {
      throw new GatewayError(404, 'not_found', `API key ${keyId} not found`);
    }

    logger.info({ keyId }, 'Key deleted via admin API');
    res.json({ id: keyId, object: 'api_key', deleted: true });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// ==================== 轮换 Key ====================
// POST /api/apps/:appId/keys/:keyId/rotate
router.post('/:appId/keys/:keyId/rotate', async (req: Request<{ appId: string; keyId: string }>, res: Response) => {
  try {
    const { keyId } = req.params;
    logger.debug({ keyId }, 'Rotating key');
    const result = await rotateApiKey(keyId);

    if (!result) {
      throw new GatewayError(404, 'not_found', `API key ${keyId} not found`);
    }

    logger.info({ keyId }, 'Key rotated via admin API');
    res.json({ object: 'api_key', ...result });
  } catch (error) {
    handleAdminError(error, res);
  }
});

export { router as appsRouter };
