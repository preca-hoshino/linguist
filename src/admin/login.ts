// src/admin/login.ts — POST /api/login 登录端点（无需 adminAuth）

import type { Request, Response } from 'express';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { findByEmail } from '@/db';
import { createLogger, GatewayError, logColors, signToken, verifyPassword } from '@/utils';
import { handleAdminError } from './error';

const logger = createLogger('Admin:Login', logColors.bold + logColors.cyan);

/** 默认 token 有效期：24 小时 */
const TOKEN_EXPIRES_IN = 86_400;

/** 登录速率限制：每 IP 每分钟最多 5 次 */
const loginRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: 'rate_limited',
      message: 'Too many login attempts, please try again later',
      type: 'rate_limit_error',
      param: null,
    },
  },
});

const loginRouter: Router = Router();

loginRouter.post('/login', loginRateLimiter, async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body as { email?: string; password?: string };

    if (email === undefined || email === '' || password === undefined || password === '') {
      throw new GatewayError(400, 'invalid_request', 'email and password are required').withParam('email');
    }

    const jwtSecret = process.env.JWT_SECRET ?? '';
    if (jwtSecret === '') {
      logger.error('JWT_SECRET environment variable is not configured');
      throw new GatewayError(500, 'config_error', 'JWT_SECRET not configured');
    }

    const user = await findByEmail(email);
    if (!user?.is_active) {
      logger.warn({ ip: req.ip, email }, 'Login failed: user not found or inactive');
      throw new GatewayError(401, 'invalid_credentials', 'Invalid credentials');
    }

    if (!verifyPassword(password, user.password_hash)) {
      logger.warn({ ip: req.ip, email }, 'Login failed: wrong password');
      throw new GatewayError(401, 'invalid_credentials', 'Invalid credentials');
    }

    const token = signToken({ sub: user.id }, jwtSecret, TOKEN_EXPIRES_IN);

    logger.info({ userId: user.id, username: user.username }, 'Login successful');

    res.json({
      object: 'access_token',
      access_token: token,
      expires_in: TOKEN_EXPIRES_IN,
      token_type: 'Bearer',
    });
  } catch (error) {
    handleAdminError(error, res);
  }
});

export { loginRouter };
