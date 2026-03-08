// src/admin/index.ts — 管理 API 路由聚合

import { Router } from 'express';
import { adminAuth } from './auth';
import providersRouter from './providers';
import providerModelsRouter from './provider-models';
import virtualModelsRouter from './virtual-models';
import requestLogsRouter from './request-logs';
import apiKeysRouter from './api-keys';
import statsRouter from './stats';

const adminRouter = Router();

// 所有管理路由都需要认证
adminRouter.use(adminAuth);

// 挂载子路由
adminRouter.use('/providers', providersRouter);
adminRouter.use('/provider-models', providerModelsRouter);
adminRouter.use('/virtual-models', virtualModelsRouter);
adminRouter.use('/request-logs', requestLogsRouter);
adminRouter.use('/api-keys', apiKeysRouter);
adminRouter.use('/stats', statsRouter);

export { adminRouter };
