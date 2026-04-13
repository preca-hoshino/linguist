// src/admin/index.ts — 管理 API 路由聚合

import { Router } from 'express';
import { appsRouter } from './apps';
import { adminAuth } from './auth';
import { copilotOAuthRouter } from './copilot-oauth';
import { loginRouter } from './login';
import { meRouter } from './me';
import { providerModelsRouter } from './provider-models';
import { providersRouter } from './providers';
import { requestLogsRouter } from './request-logs';
import { statsRouter } from './stats';
import { publicUsersRouter, usersRouter } from './users';
import { virtualModelsRouter } from './virtual-models';
import { mcpProvidersRouter } from './mcp-providers';
import { mcpVirtualServersRouter } from './mcp-virtual-servers';
import { mcpLogsRouter } from './mcp-logs';
import { mcpStatsRouter } from './mcp-stats';

const adminRouter: Router = Router();

// 公开管理路由 (无需认证)
adminRouter.use('/users', publicUsersRouter);
adminRouter.use(loginRouter);

// 所有其他管理路由都需要认证
adminRouter.use(adminAuth);

// 挂载子路由
adminRouter.use('/providers', providersRouter);
adminRouter.use('/provider-models', providerModelsRouter);
adminRouter.use('/virtual-models', virtualModelsRouter);
adminRouter.use('/request-logs', requestLogsRouter);
adminRouter.use('/mcp-providers', mcpProvidersRouter);
adminRouter.use('/virtual-mcps', mcpVirtualServersRouter);
adminRouter.use('/mcp-logs', mcpLogsRouter);
adminRouter.use('/mcp-stats', mcpStatsRouter);
adminRouter.use('/apps', appsRouter);
adminRouter.use('/stats', statsRouter);
adminRouter.use('/users', usersRouter);
adminRouter.use('/me', meRouter);
adminRouter.use('/oauth/copilot', copilotOAuthRouter);

export { adminRouter };
