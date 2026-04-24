import { Router } from 'express';
import { mcpLogsRouter } from './logs';
import { mcpProvidersRouter } from './provider-mcps';
import { mcpStatsRouter } from './stats';
import { mcpVirtualServersRouter } from './virtual-mcps';

const mcpRouter: Router = Router();

mcpRouter.use('/provider-mcps', mcpProvidersRouter);
mcpRouter.use('/virtual-mcps', mcpVirtualServersRouter);
mcpRouter.use('/logs', mcpLogsRouter);
mcpRouter.use('/stats', mcpStatsRouter);

export { mcpRouter };
