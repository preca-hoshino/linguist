// src/api/claude/index.ts — Anthropic Messages API 端点

import type { Request, Response } from 'express';
import { Router } from 'express';
import { processChatCompletion } from '@/app';
import { createLogger, logColors } from '@/utils';

const logger = createLogger('API:Anthropic', logColors.bold + logColors.magenta);

const router: Router = Router();

/**
 * Anthropic 格式 API Key 提取
 * 从 x-api-key 头提取（Anthropic SDK 默认行为）
 */
export function extractApiKey(req: Request): string | undefined {
  const key = req.headers['x-api-key'];
  if (typeof key !== 'string' || key.length === 0) {
    return;
  }
  return key;
}

/**
 * POST /v1/messages — Anthropic Messages API
 *
 * model 从请求体 body.model 提取
 * stream 由请求体 body.stream 决定
 */
router.post('/v1/messages', async (req: Request, res: Response): Promise<void> => {
  const requestBody = req.body as Record<string, unknown>;
  const rawModel = typeof requestBody.model === 'string' ? requestBody.model : '';
  const isStream = requestBody.stream === true;

  logger.debug({ model: rawModel, stream: isStream, ip: req.ip ?? req.socket.remoteAddress }, 'POST /v1/messages');

  await processChatCompletion(req, res, 'anthropic', rawModel, { stream: isStream });
});

export { router as anthropicRouter };
