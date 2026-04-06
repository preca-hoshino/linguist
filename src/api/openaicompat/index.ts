// src/api/openaicompat/index.ts — OpenAI 兼容格式 API 端点

import type { Request, Response } from 'express';
import { Router } from 'express';
import { processChatCompletion, processEmbedding } from '@/app';
import { configManager } from '@/config';
import { handleError } from '@/users';
import { createLogger, logColors } from '@/utils';
import { validateApiKeyFromRequest } from './auth-helper';

const logger = createLogger('API:OpenAICompat', logColors.bold + logColors.white);

const router: Router = Router();

/**
 * OpenAI 格式 API Key 提取
 * 从 Authorization: Bearer <key> 头提取
 */
export function extractApiKey(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return;
  }
  const token = header.slice(7);
  return token.length > 0 ? token : undefined;
}

/**
 * GET /v1/models — 返回可调用的虚拟模型列表（OpenAI 规范）
 * https://platform.openai.com/docs/api-reference/models/list
 */
router.get('/v1/models', async (req: Request, res: Response): Promise<void> => {
  logger.debug({ ip: req.ip ?? req.socket.remoteAddress }, 'GET /v1/models');
  try {
    // API Key 鉴权（复用统一鉴权逻辑）
    await validateApiKeyFromRequest(req, extractApiKey);

    const modelNames = configManager.getAllVirtualModels();

    const data = modelNames.map((name) => {
      const vmConfig = configManager.getVirtualModelConfig(name);
      return {
        id: name,
        object: 'model',
        created: 0,
        owned_by: 'linguist',
        ...(vmConfig ? { model_type: vmConfig.modelType } : {}),
      };
    });

    res.json({ object: 'list', data });
  } catch (error) {
    handleError(error, res, 'openaicompat');
  }
});

/**
 * POST /v1/chat/completions — OpenAI 兼容格式
 * model 从请求体 body.model 提取
 */
router.post('/v1/chat/completions', async (req: Request, res: Response): Promise<void> => {
  const requestBody = req.body as Record<string, unknown>;
  const rawModel = typeof requestBody.model === 'string' ? requestBody.model : '';
  logger.debug({ model: rawModel, ip: req.ip ?? req.socket.remoteAddress }, 'POST /v1/chat/completions');
  await processChatCompletion(req, res, 'openaicompat', rawModel);
});

/**
 * POST /v1/embeddings — OpenAI 兼容嵌入格式
 * model 从请求体 body.model 提取
 */
router.post('/v1/embeddings', async (req: Request, res: Response): Promise<void> => {
  const requestBody = req.body as Record<string, unknown>;
  const rawModel = typeof requestBody.model === 'string' ? requestBody.model : '';
  logger.debug({ model: rawModel, ip: req.ip ?? req.socket.remoteAddress }, 'POST /v1/embeddings');
  await processEmbedding(req, res, 'openaicompat', rawModel);
});

export { router as openaiCompatRouter };
