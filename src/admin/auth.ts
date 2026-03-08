// src/admin/auth.ts — 管理 API 认证中间件

import type { Request, Response, NextFunction } from 'express';
import { createLogger, logColors } from '../utils';

const logger = createLogger('Admin:Auth', logColors.bold + logColors.red);

/**
 * 管理 API Bearer Token 认证中间件
 * 校验请求头 Authorization: Bearer <ADMIN_KEY>
 */
export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const adminKey = process.env['ADMIN_KEY'];
  if (adminKey === undefined || adminKey === '') {
    logger.error('ADMIN_KEY environment variable is not configured');
    res.status(500).json({ error: { code: 'config_error', message: 'ADMIN_KEY not configured' } });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    logger.warn({ ip: req.ip, path: req.path, method: req.method }, 'Missing or invalid Authorization header');
    res.status(401).json({ error: { code: 'unauthorized', message: 'Missing or invalid Authorization header' } });
    return;
  }

  const token = authHeader.slice(7);
  if (token !== adminKey) {
    logger.warn({ ip: req.ip, path: req.path, method: req.method }, 'Invalid admin key attempt');
    res.status(403).json({ error: { code: 'forbidden', message: 'Invalid admin key' } });
    return;
  }

  logger.debug({ path: req.path, method: req.method }, 'Admin auth passed');
  next();
}
