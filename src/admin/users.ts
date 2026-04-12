// src/admin/users.ts — 用户管理路由（adminAuth 保护）

import type { Request, Response } from 'express';
import { Router } from 'express';
import type { UserUpdateData } from '@/db';
import { createUser, deleteUser, getUserAvatarData, listUsers, updateUser } from '@/db';
import { createLogger, GatewayError, logColors } from '@/utils';
import { handleAdminError } from './error';

const logger = createLogger('Admin:Users', logColors.bold + logColors.magenta);

const usersRouter: Router = Router();
export const publicUsersRouter: Router = Router();

/** GET /api/users — 列出所有用户 */
usersRouter.get('/', async (req: Request, res: Response) => {
  try {
    const { search, limit, starting_after } = req.query;
    const limitNum = typeof limit === 'string' && limit !== '' ? Math.min(Number.parseInt(limit, 10), 100) : 10;
    const startingAfterStr = typeof starting_after === 'string' ? starting_after.trim() : undefined;
    const searchStr = typeof search === 'string' ? search : undefined;

    const {
      data: users,
      total,
      has_more,
    } = await listUsers({
      limit: limitNum,
      ...(startingAfterStr !== undefined ? { starting_after: startingAfterStr } : {}),
      ...(searchStr === undefined ? {} : { search: searchStr }),
    });

    // 对外暴露时将 avatar_data 替换为 avatar_url 路由地址
    const data = users.map((u) => ({
      object: 'user' as const,
      id: u.id,
      username: u.username,
      email: u.email,
      avatar_url: u.avatar_data ? `/api/users/${u.id}/avatar` : '',
      is_active: u.is_active,
      created_at: u.created_at,
      updated_at: u.updated_at,
    }));

    res.json({ object: 'list', url: '/api/users', data, total, has_more });
  } catch (error) {
    handleAdminError(error, res);
  }
});

/** POST /api/users — 创建用户 */
usersRouter.post('/', async (req: Request, res: Response) => {
  try {
    const { username, email, password, avatar_data } = req.body as {
      username?: string;
      email?: string;
      password?: string;
      avatar_data?: string;
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

    const user = await createUser({ username, email, password, avatar_data: avatar_data ?? '' });
    logger.info({ userId: user.id, username }, 'User created');
    res.status(201).json({
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
usersRouter.patch('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { username, email, password, avatar_data, is_active } = req.body as {
      username?: string;
      email?: string;
      password?: string;
      avatar_data?: string;
      is_active?: boolean;
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
usersRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
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
