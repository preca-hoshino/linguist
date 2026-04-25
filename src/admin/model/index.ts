import { Router } from 'express';
import { copilotOAuthRouter } from './copilot-oauth';
import { requestLogsRouter } from './logs';
import { providerModelsRouter } from './provider-models';
import { providersRouter } from './providers';
import { statsRouter } from './stats';
import { virtualModelsRouter } from './virtual-models';

const modelRouter: Router = Router();

modelRouter.use('/providers', providersRouter);
modelRouter.use('/provider-models', providerModelsRouter);
modelRouter.use('/virtual-models', virtualModelsRouter);
modelRouter.use('/logs', requestLogsRouter);
modelRouter.use('/stats', statsRouter);
modelRouter.use('/oauth/copilot', copilotOAuthRouter);

export { modelRouter };
