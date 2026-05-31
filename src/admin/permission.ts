// src/admin/permission.ts — 权限校验中间件

import type { NextFunction, Request, Response } from 'express';
import { findUserById } from '@/db';
import type { ApiErrorResponse, PermissionLevel, PermissionModule, UserPermissions } from '@/types';
import { hasPermission } from '@/types';
import { createLogger, logColors } from '@/utils';

const logger = createLogger('Admin:Permission', logColors.bold + logColors.yellow);

/**
 * 权限校验中间件工厂
 * 必须在 adminAuth 之后使用（依赖 res.locals.userId）
 *
 * @param module - 要求的权限模块
 * @param level  - 要求的权限级别
 */
export function requirePermission(module: PermissionModule, level: PermissionLevel) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const userId = res.locals.userId as string | undefined;
    if (userId === undefined || userId === '') {
      const body: ApiErrorResponse = {
        error: {
          code: 'unauthorized',
          message: 'Not authenticated',
          type: 'authentication_error',
          param: null,
        },
      };
      res.status(401).json(body);
      return;
    }

    // 已缓存用户信息时直接使用
    let permissions: UserPermissions | undefined = res.locals.userPermissions as UserPermissions | undefined;

    if (permissions === undefined) {
      const user = await findUserById(userId);
      if (!user) {
        const body: ApiErrorResponse = {
          error: {
            code: 'not_found',
            message: 'User not found',
            type: 'not_found_error',
            param: null,
          },
        };
        res.status(404).json(body);
        return;
      }
      permissions = user.permissions;
      // 缓存到 res.locals 避免下游重复查询
      res.locals.userPermissions = permissions;
    }

    if (!hasPermission(permissions, module, level)) {
      logger.warn(
        { userId, module, level, path: req.path, method: req.method },
        'Permission denied',
      );
      const body: ApiErrorResponse = {
        error: {
          code: 'insufficient_permissions',
          message: `Insufficient permissions: requires ${module}:${level}`,
          type: 'authentication_error',
          param: null,
        },
      };
      res.status(403).json(body);
      return;
    }

    next();
  };
}
