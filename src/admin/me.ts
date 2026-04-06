// src/admin/me.ts — GET /api/me 当前登录用户信息

import type { Request, Response } from 'express';
import { Router } from 'express';
import { findUserById } from '@/db';
import { createLogger, GatewayError, logColors } from '@/utils';
import { handleAdminError } from './error';

const logger = createLogger('Admin:Me', logColors.bold + logColors.cyan);

const meRouter: Router = Router();

/**
 * GET /api/me — 获取当前登录用户的实时信息（从数据库读取，始终最新）
 * 依赖 adminAuth 中间件注入的 res.locals.userId
 */
meRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const userId = res.locals.userId as string | undefined;

    if (userId === undefined || userId === '') {
      throw new GatewayError(401, 'unauthorized', 'Not authenticated');
    }

    const user = await findUserById(userId);

    if (!user) {
      throw new GatewayError(404, 'not_found', 'User not found');
    }

    logger.debug({ userId }, 'Fetched current user info');

    res.json({
      object: 'user',
      id: user.id,
      username: user.username,
      email: user.email,
      avatar_url: user.avatar_data ? `/api/users/${user.id}/avatar` : '',
      is_active: user.is_active,
      created_at: user.created_at,
      updated_at: user.updated_at,
    });
  } catch (error) {
    handleAdminError(error, res);
  }
});

export { meRouter };
