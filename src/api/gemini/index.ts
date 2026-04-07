// src/api/gemini/index.ts — Gemini 原生格式 API 端点

import type { Request, Response } from 'express';
import { Router } from 'express';
import { processChatCompletion, processEmbedding } from '@/app';
import { configManager } from '@/config';
import { handleError } from '@/users';
import { createLogger, logColors } from '@/utils';
import { validateApiKeyFromRequest } from '../auth-helper';

const logger = createLogger('API:Gemini', logColors.bold + logColors.white);

const router: Router = Router();

/**
 * Gemini 格式 API Key 提取
 * 从 x-goog-api-key 头 或 ?key= 查询参数提取
 */
export function extractApiKey(req: Request): string | undefined {
  const header = req.headers['x-goog-api-key'];
  const apiKey = Array.isArray(header) ? header[0] : header;
  return apiKey ?? (req.query.key as string | undefined);
}

/**
 * POST /v1beta/models/:model\:generateContent — Gemini 原生格式（非流式）
 * model 从 URL 路径参数 :model 提取
 */
router.post(String.raw`/v1beta/models/:model\:generateContent`, async (req: Request, res: Response): Promise<void> => {
  const modelParam = req.params.model;
  const rawModel = typeof modelParam === 'string' ? modelParam : '';
  logger.debug(
    { model: rawModel, ip: req.ip ?? req.socket.remoteAddress },
    `POST /v1beta/models/${rawModel}:generateContent`,
  );
  await processChatCompletion(req, res, 'gemini', rawModel);
});

/**
 * POST /v1beta/models/:model\:streamGenerateContent — Gemini 原生格式（流式）
 * model 从 URL 路径参数 :model 提取
 * 通过注入 stream: true 到 request body 触发流式处理
 */
router.post(
  String.raw`/v1beta/models/:model\:streamGenerateContent`,
  async (req: Request, res: Response): Promise<void> => {
    const modelParam = req.params.model;
    const rawModel = typeof modelParam === 'string' ? modelParam : '';
    logger.debug(
      { model: rawModel, ip: req.ip ?? req.socket.remoteAddress },
      `POST /v1beta/models/${rawModel}:streamGenerateContent`,
    );
    // Gemini 流式由 URL 端点决定，通过 options.stream 传递给核心流程
    await processChatCompletion(req, res, 'gemini', rawModel, { stream: true });
  },
);

/**
 * POST /v1beta/models/:model\:embedContent — Gemini 单条嵌入
 * model 从 URL 路径参数 :model 提取
 */
router.post(String.raw`/v1beta/models/:model\:embedContent`, async (req: Request, res: Response): Promise<void> => {
  const modelParam = req.params.model;
  const rawModel = typeof modelParam === 'string' ? modelParam : '';
  logger.debug(
    { model: rawModel, ip: req.ip ?? req.socket.remoteAddress },
    `POST /v1beta/models/${rawModel}:embedContent`,
  );
  await processEmbedding(req, res, 'gemini', rawModel);
});

/**
 * GET /v1beta/models — 返回可调用的虚拟模型列表（Gemini 规范）
 */
router.get('/v1beta/models', async (req: Request, res: Response): Promise<void> => {
  logger.debug({ ip: req.ip ?? req.socket.remoteAddress }, 'GET /v1beta/models');
  try {
    await validateApiKeyFromRequest(
      req,
      extractApiKey,
      'API key is required. Provide it via x-goog-api-key header or key query parameter.',
    );

    const modelNames = configManager.getAllVirtualModels();

    const models = modelNames.map((name) => {
      return {
        name,
        version: '1.0',
        displayName: name,
        description: 'Linguist Virtual Model',
      };
    });

    res.json({ models });
  } catch (error) {
    handleError(error, res, 'gemini');
  }
});

export { router as geminiRouter };
