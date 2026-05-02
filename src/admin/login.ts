// src/admin/login.ts — POST /api/login 登录端点（无需 adminAuth）

import type { Request, Response } from 'express';
import { Router } from 'express';
import { findByEmail } from '@/db';
import type { ApiErrorResponse } from '@/types/api';
import { createLogger, logColors, signToken, verifyPassword } from '@/utils';

const logger = createLogger('Admin:Login', logColors.bold + logColors.cyan);

/** 默认 token 有效期：24 小时 */
const TOKEN_EXPIRES_IN = 86_400;

const loginRouter: Router = Router();

loginRouter.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body as { email?: string; password?: string };

    if (email === undefined || email === '' || password === undefined || password === '') {
      const body: ApiErrorResponse = {
        error: {
          code: 'invalid_request',
          message: 'email and password are required',
          type: 'invalid_request_error',
          param: null,
        },
      };
      res.status(400).json(body);
      return;
    }

    const jwtSecret = process.env.JWT_SECRET ?? '';
    if (jwtSecret === '') {
      logger.error('JWT_SECRET environment variable is not configured');
      const body: ApiErrorResponse = {
        error: { code: 'config_error', message: 'JWT_SECRET not configured', type: 'server_error', param: null },
      };
      res.status(500).json(body);
      return;
    }

    const user = await findByEmail(email);
    if (!user?.is_active) {
      logger.warn({ ip: req.ip, email }, 'Login failed: user not found or inactive');
      const body: ApiErrorResponse = {
        error: {
          code: 'invalid_credentials',
          message: 'Invalid credentials',
          type: 'authentication_error',
          param: null,
        },
      };
      res.status(401).json(body);
      return;
    }

    if (!verifyPassword(password, user.password_hash)) {
      logger.warn({ ip: req.ip, email }, 'Login failed: wrong password');
      const body: ApiErrorResponse = {
        error: {
          code: 'invalid_credentials',
          message: 'Invalid credentials',
          type: 'authentication_error',
          param: null,
        },
      };
      res.status(401).json(body);
      return;
    }

    const token = signToken({ sub: user.id }, jwtSecret, TOKEN_EXPIRES_IN);

    logger.info({ userId: user.id, username: user.username }, 'Login successful');

    res.json({
      access_token: token,
      expires_in: TOKEN_EXPIRES_IN,
      token_type: 'Bearer',
    });
  } catch (error) {
    logger.error(error instanceof Error ? error : new Error(String(error)), 'Login error');
    const body: ApiErrorResponse = {
      error: { code: 'internal_error', message: 'Internal server error', type: 'server_error', param: null },
    };
    res.status(500).json(body);
  }
});

export { loginRouter };
