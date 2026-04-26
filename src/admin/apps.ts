// src/admin/apps.ts — 应用（App）管理 API（Stripe 风格）
// 嵌套资源：Apps + Keys，游标分页，POST 更新

import type { Request, Response } from 'express';
import { Router } from 'express';
import { createApp, deleteApp, getAppById, listApps, rotateAppKey, updateApp } from '@/db/apps';
import { createLogger, GatewayError, logColors } from '@/utils';
import { handleAdminError } from './error';

const logger = createLogger('Admin:Apps', logColors.bold + logColors.blue);

const router: Router = Router();

// ====================================================================
//  应用（App）CRUD
// ====================================================================

// ==================== 列出应用（Offset 分页） ====================
// GET /admin/apps?limit=10&offset=0&search=xxx
router.get('/', async (req: Request, res: Response) => {
  try {
    const { limit, offset, search, is_active } = req.query;
    const limitNum = typeof limit === 'string' && limit !== '' ? Math.min(Number.parseInt(limit, 10), 100) : undefined;
    const offsetNum = typeof offset === 'string' && offset !== '' ? Math.max(Number.parseInt(offset, 10), 0) : 0;
    const searchStr = typeof search === 'string' ? search : undefined;
    const isActiveParam =
      typeof is_active === 'string' && is_active !== '' ? is_active.toLowerCase() === 'true' : undefined;

    logger.debug({ search: searchStr, limit: limitNum, offset: offsetNum, is_active: isActiveParam }, 'Listing apps');

    const result = await listApps({
      ...(limitNum !== undefined ? { limit: limitNum } : {}),
      offset: offsetNum,
      ...(searchStr !== undefined ? { search: searchStr } : {}),
      ...(isActiveParam !== undefined ? { is_active: isActiveParam } : {}),
    });

    const data = result.data.map((a) => ({ object: 'app' as const, ...a }));

    logger.debug({ count: data.length, has_more: result.has_more, total: result.total }, 'Apps listed');
    res.json({
      object: 'list',
      url: '/admin/apps',
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
    const body = req.body as { name?: string; allowed_model_ids?: string[]; allowed_mcp_ids?: string[] };
    const { name, allowed_model_ids, allowed_mcp_ids } = body;

    if (typeof name !== 'string' || name === '') {
      throw new GatewayError(400, 'invalid_request', 'Field "name" is required and must be a non-empty string');
    }

    logger.debug({ name }, 'Creating app');
    const app = await createApp({ name, allowed_model_ids, allowed_mcp_ids });
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
    const body = req.body as {
      name?: string;
      is_active?: boolean;
      allowed_model_ids?: string[];
      allowed_mcp_ids?: string[];
    };

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
//  应用级别 API Key 管理
// ====================================================================

// ==================== 轮换应用 API Key ====================
// POST /api/apps/:id/rotate-key
router.post('/:id/rotate-key', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const { id } = req.params;
    logger.debug({ id }, 'Rotating app API key');
    const result = await rotateAppKey(id);

    if (!result) {
      throw new GatewayError(404, 'not_found', `App ${id} not found`);
    }

    logger.info({ id }, 'App API key rotated via admin API');
    res.json({ object: 'app', ...result });
  } catch (error) {
    handleAdminError(error, res);
  }
});

export { router as appsRouter };
