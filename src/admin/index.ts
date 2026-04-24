// src/admin/index.ts — 管理 API 路由聚合

import { Router } from 'express';
import { appsRouter } from './apps';
import { adminAuth } from './auth';
import { loginRouter } from './login';
import { mcpRouter } from './mcp';
import { meRouter } from './me';
import { modelRouter } from './model';
import { publicUsersRouter, usersRouter } from './users';

const adminRouter: Router = Router();

// 公开管理路由 (无需认证)
adminRouter.use('/users', publicUsersRouter);
adminRouter.use(loginRouter);

// 所有其他管理路由都需要认证
adminRouter.use(adminAuth);

// 挂载 Stripe 哲学的幂等性捕捉层 (用于处理所有 POST 并捕获 Idempotency-Key)
import { idempotencyMiddleware } from './idempotency';

adminRouter.use(idempotencyMiddleware);

// 挂载子路由
adminRouter.use('/model', modelRouter);
adminRouter.use('/mcp', mcpRouter);
adminRouter.use('/apps', appsRouter);
adminRouter.use('/users', usersRouter);
adminRouter.use('/me', meRouter);

export { adminRouter };
