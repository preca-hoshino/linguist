// src/admin/auth.ts — 管理 API JWT 认证中间件

import type { NextFunction, Request, Response } from 'express';
import { findUserById } from '@/db';
import type { ApiErrorResponse } from '@/types';
import { createLogger, logColors, verifyToken } from '@/utils';

const logger = createLogger('Admin:Auth', logColors.bold + logColors.red);

/**
 * 管理 API JWT Bearer Token 认证中间件
 * 校验请求头 Authorization: Bearer <jwt_token>
 *
 * 认证成功后注入：
 * - res.locals.userId   — 用户 ID
 * - res.locals.user     — 完整用户对象（含 permissions）
 * - res.locals.userPermissions — 权限对象（供下游 requirePermission 缓存）
 */
export async function adminAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const jwtSecret = process.env.JWT_SECRET ?? '';
  if (jwtSecret === '') {
    logger.error('JWT_SECRET environment variable is not configured');
    const body: ApiErrorResponse = {
      error: { code: 'config_error', message: 'JWT_SECRET not configured', type: 'server_error', param: null },
    };
    res.status(500).json(body);
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    logger.warn({ ip: req.ip, path: req.path, method: req.method }, 'Missing or invalid Authorization header');
    const body: ApiErrorResponse = {
      error: {
        code: 'unauthorized',
        message: 'Missing or invalid Authorization header',
        type: 'authentication_error',
        param: null,
      },
    };
    res.status(401).json(body);
    return;
  }

  const token = authHeader.slice(7);
  const payload = verifyToken(token, jwtSecret);

  if (!payload) {
    logger.warn({ ip: req.ip, path: req.path, method: req.method }, 'Invalid or expired token');
    const body: ApiErrorResponse = {
      error: {
        code: 'unauthorized',
        message: 'Invalid or expired token',
        type: 'authentication_error',
        param: null,
      },
    };
    res.status(401).json(body);
    return;
  }

  // 注入 userId
  res.locals.userId = payload.sub;

  // 查询完整用户信息（含 permissions），缓存到 res.locals
  try {
    const user = await findUserById(payload.sub);
    if (user) {
      res.locals.user = user;
      res.locals.userPermissions = user.permissions;
    }
  } catch {
    // 查询失败不阻塞认证，下游权限中间件会再次查询
    logger.debug({ userId: payload.sub }, 'Failed to prefetch user in auth middleware');
  }

  logger.debug({ path: req.path, method: req.method, userId: payload.sub }, 'Admin auth passed');
  next();
}
