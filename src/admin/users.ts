// src/admin/users.ts — 用户管理路由（adminAuth 保护）

import type { Request, Response } from 'express';
import { Router } from 'express';
import type { UserUpdateData } from '@/db';
import { createUser, deleteUser, findUserById, getUserAvatarData, listUsers, updateUser } from '@/db';
import type { UserPermissions } from '@/types';
import { canManageUser, hasPermission, PERMISSION_MODULES, validatePermissions } from '@/types';
import { createLogger, GatewayError, logColors } from '@/utils';
import { handleAdminError } from './error';
import { validateMetadata } from './metadata-validator';
import { requirePermission } from './permission';

const logger = createLogger('Admin:Users', logColors.bold + logColors.magenta);

const usersRouter: Router = Router();
export const publicUsersRouter: Router = Router();

// 用户管理全部需要 users:view 权限
usersRouter.use(requirePermission('users', 'view'));

/** GET /api/users — 列出所有用户 */
usersRouter.get('/', async (req: Request, res: Response) => {
  try {
    const { search, limit, offset, is_active } = req.query;
    const limitNum =
      typeof limit === 'string' && limit !== '' ? Math.min(Math.max(Number.parseInt(limit, 10), 1), 100) : 10;
    const offsetNum = typeof offset === 'string' && offset !== '' ? Math.max(Number.parseInt(offset, 10), 0) : 0;
    const searchStr = typeof search === 'string' ? search : undefined;
    const isActiveParam =
      typeof is_active === 'string' && is_active !== '' ? is_active.toLowerCase() === 'true' : undefined;

    const {
      data: users,
      total,
      has_more,
    } = await listUsers({
      limit: limitNum,
      offset: offsetNum,
      ...(searchStr === undefined ? {} : { search: searchStr }),
      ...(isActiveParam === undefined ? {} : { is_active: isActiveParam }),
    });

    // 对外暴露时将 avatar_data 替换为 avatar_url 路由地址
    const data = users.map((u) => ({
      object: 'user' as const,
      id: u.id,
      username: u.username,
      email: u.email,
      avatar_url: u.avatar_data ? `/api/users/${u.id}/avatar` : '',
      is_active: u.is_active,
      permissions: u.permissions,
      created_at: u.created_at,
      updated_at: u.updated_at,
    }));

    res.json({ object: 'list', url: '/admin/users', data, total, has_more });
  } catch (error) {
    handleAdminError(error, res);
  }
});

/** POST /api/users — 创建用户 */
usersRouter.post('/', requirePermission('users', 'edit'), async (req: Request, res: Response) => {
  try {
    const { username, email, password, avatar_data, metadata, permissions } = req.body as {
      username?: string;
      email?: string;
      password?: string;
      avatar_data?: string;
      metadata?: Record<string, string>;
      permissions?: UserPermissions;
    };

    if (
      username === undefined ||
      username === '' ||
      email === undefined ||
      email === '' ||
      password === undefined ||
      password === ''
    ) {
      throw new GatewayError(400, 'invalid_request', 'username, email and password are required');
    }

    validateMetadata(metadata);

    // 验证权限结构（如传入）
    if (permissions !== undefined && !validatePermissions(permissions)) {
      throw new GatewayError(400, 'invalid_request', 'Invalid permissions structure');
    }

    // 权限天花板：不能授予超过自身权限的级别
    if (permissions !== undefined) {
      const requestUserPerms = res.locals.userPermissions as UserPermissions | undefined;
      if (requestUserPerms) {
        for (const mod of PERMISSION_MODULES) {
          if (!hasPermission(requestUserPerms, mod, permissions[mod])) {
            throw new GatewayError(
              403,
              'insufficient_permissions',
              `Cannot grant ${mod}:${permissions[mod]} — your level is ${requestUserPerms[mod]}`,
            );
          }
        }
      }
    }

    const user = await createUser({
      username,
      email,
      password,
      avatar_data: avatar_data ?? '',
      ...(permissions !== undefined ? { permissions } : {}),
    });
    logger.info({ userId: user.id, username }, 'User created');
    res.status(201).json({
      object: 'user',
      id: user.id,
      username: user.username,
      email: user.email,
      avatar_url: user.avatar_data ? `/api/users/${user.id}/avatar` : '',
      is_active: user.is_active,
      permissions: user.permissions,
      created_at: user.created_at,
      updated_at: user.updated_at,
    });
  } catch (error) {
    // 唯一约束冲突 → 409
    const errMsg = error instanceof Error ? error.message : String(error);
    if (errMsg.includes('duplicate key') || errMsg.includes('unique')) {
      handleAdminError(new GatewayError(409, 'conflict', 'Username or email already exists'), res);
      return;
    }
    handleAdminError(error, res);
  }
});

/** PATCH /api/users/:id — 通用用户更新（支持部分字段） */
usersRouter.patch('/:id', requirePermission('users', 'edit'), async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { username, email, password, avatar_data, is_active, metadata, permissions } = req.body as {
      username?: string;
      email?: string;
      password?: string;
      avatar_data?: string;
      is_active?: boolean;
      metadata?: Record<string, string>;
      permissions?: UserPermissions;
    };

    const data: UserUpdateData = {};
    if (username !== undefined) {
      data.username = username;
    }
    if (email !== undefined) {
      data.email = email;
    }
    if (password !== undefined) {
      data.password = password;
    }
    if (avatar_data !== undefined) {
      data.avatar_data = avatar_data;
    }
    if (is_active !== undefined) {
      data.is_active = is_active;
    }

    // 权限更新
    if (permissions !== undefined) {
      if (!validatePermissions(permissions)) {
        throw new GatewayError(400, 'invalid_request', 'Invalid permissions structure');
      }

      // 自保护：禁止修改自己的权限
      const requestUserId = res.locals.userId as string | undefined;
      if (requestUserId === id) {
        throw new GatewayError(400, 'invalid_request', 'Cannot modify your own permissions');
      }

      // 权限天花板：不能授予超过自身权限的级别
      const requestUserPerms = res.locals.userPermissions as UserPermissions | undefined;
      if (requestUserPerms) {
        for (const mod of PERMISSION_MODULES) {
          if (!hasPermission(requestUserPerms, mod, permissions[mod])) {
            throw new GatewayError(
              403,
              'insufficient_permissions',
              `Cannot grant ${mod}:${permissions[mod]} — your level is ${requestUserPerms[mod]}`,
            );
          }
        }
      }

      data.permissions = permissions;
    }

    // 目标用户天花板：不能编辑权限高于自己的用户
    const patchRequestUserId = res.locals.userId as string | undefined;
    if (patchRequestUserId !== id) {
      const patchRequestPerms = res.locals.userPermissions as UserPermissions | undefined;
      const targetUser = await findUserById(id);
      if (targetUser && patchRequestPerms && !canManageUser(patchRequestPerms, targetUser.permissions)) {
        throw new GatewayError(
          403,
          'insufficient_permissions',
          'Cannot modify a user with higher permissions than your own',
        );
      }
    }

    validateMetadata(metadata);

    const user = await updateUser(id, data);
    if (!user) {
      throw new GatewayError(404, 'not_found', 'User not found');
    }

    logger.info({ userId: id, fields: Object.keys(data) }, 'User updated');
    res.json({
      object: 'user',
      id: user.id,
      username: user.username,
      email: user.email,
      avatar_url: user.avatar_data ? `/api/users/${user.id}/avatar` : '',
      is_active: user.is_active,
      permissions: user.permissions,
      created_at: user.created_at,
      updated_at: user.updated_at,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    if (errMsg.includes('duplicate key') || errMsg.includes('unique')) {
      handleAdminError(new GatewayError(409, 'conflict', 'Username or email already exists'), res);
      return;
    }
    handleAdminError(error, res);
  }
});

/** GET /api/users/:id/avatar — 获取头像二进制流 (Public) */
publicUsersRouter.get('/:id/avatar', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const avatarData = await getUserAvatarData(id);

    if (avatarData === null || avatarData === '') {
      throw new GatewayError(404, 'not_found', 'Avatar not found');
    }

    // 解析 Data URI：data:image/png;base64,iVBOR...
    const match = new RegExp(/^data:(.+);base64,(.+)$/).exec(avatarData);
    if (!match) {
      throw new GatewayError(404, 'not_found', 'Invalid avatar data');
    }

    const [, mimeType = '', base64Data = ''] = match;
    const buffer = Buffer.from(base64Data, 'base64');

    res.set('Content-Type', mimeType);
    res.set('Content-Length', buffer.length.toString());
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(buffer);
  } catch (error) {
    handleAdminError(error, res);
  }
});

/** DELETE /api/users/:id — 删除用户 */
usersRouter.delete('/:id', requirePermission('users', 'edit'), async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;

    // 防止自删除
    const requestUserId = res.locals.userId as string | undefined;
    if (requestUserId === id) {
      throw new GatewayError(400, 'invalid_request', 'Cannot delete your own account');
    }

    // 目标用户天花板：不能删除权限高于自己的用户
    const delRequestPerms = res.locals.userPermissions as UserPermissions | undefined;
    const targetUser = await findUserById(id);
    if (targetUser && delRequestPerms && !canManageUser(delRequestPerms, targetUser.permissions)) {
      throw new GatewayError(
        403,
        'insufficient_permissions',
        'Cannot delete a user with higher permissions than your own',
      );
    }

    const deleted = await deleteUser(id);
    if (!deleted) {
      throw new GatewayError(404, 'not_found', 'User not found');
    }

    logger.info({ userId: id }, 'User deleted');
    res.json({ id, object: 'user', deleted: true });
  } catch (error) {
    handleAdminError(error, res);
  }
});

export { usersRouter };
