// src/admin/auth.ts — 管理 API JWT 认证中间件

import type { NextFunction, Request, Response } from 'express';
import type { ApiErrorResponse } from '@/types/api';
import { createLogger, logColors, verifyToken } from '@/utils';

const logger = createLogger('Admin:Auth', logColors.bold + logColors.red);

/**
 * 管理 API JWT Bearer Token 认证中间件
 * 校验请求头 Authorization: Bearer <jwt_token>
 */
export function adminAuth(req: Request, res: Response, next: NextFunction): void {
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

  // 注入 userId 到 res.locals 供下游使用
  res.locals.userId = payload.sub;

  logger.debug({ path: req.path, method: req.method, userId: payload.sub }, 'Admin auth passed');
  next();
}
