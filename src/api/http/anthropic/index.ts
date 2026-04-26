// src/api/claude/index.ts — Anthropic Messages API 端点

import type { Request, Response } from 'express';
import { Router } from 'express';
import { configManager } from '@/config';
import { processChatCompletion } from '@/model/http/app';
import { handleError } from '@/model/http/users';
import { createLogger, logColors } from '@/utils';
import { validateApiKeyFromRequest } from '../auth-helper';

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

/**
 * POST /v1/messages/count_tokens — Token Counting API (估算实现)
 *
 * 目前采用本地字符粗略估算 (长度 / 4) 以满足 Claude Code 等依赖此端点估算上下文的客户端
 */
router.post('/v1/messages/count_tokens', async (req: Request, res: Response): Promise<void> => {
  logger.debug({ ip: req.ip ?? req.socket.remoteAddress }, 'POST /v1/messages/count_tokens');
  try {
    // 基础校验 API Key，防止未授权访问
    await validateApiKeyFromRequest(req, extractApiKey, 'API key is required. Provide it via x-api-key header.');

    // 简单高效的本地 Token 估算：通常 1 个 token 约等于 4 个英文字符或 1.5 个汉字
    // 为避免解析开销，直接将请求体序列化并除以 4
    const payloadStr = JSON.stringify(req.body ?? {});
    const estimatedTokens = Math.max(1, Math.ceil(payloadStr.length / 4));

    res.json({
      input_tokens: estimatedTokens,
    });
  } catch (error) {
    handleError(error, res, 'anthropic');
  }
});

/**
 * GET /v1/models — 返回可调用的虚拟模型列表（Anthropic 规范）
 */
router.get('/v1/models', async (req: Request, res: Response): Promise<void> => {
  logger.debug({ ip: req.ip ?? req.socket.remoteAddress }, 'GET /v1/models');
  try {
    const appInfo = await validateApiKeyFromRequest(
      req,
      extractApiKey,
      'API key is required. Provide it via x-api-key header.',
    );

    let modelNames = configManager.getAllVirtualModels();
    if (appInfo && appInfo.allowedModelIds.length > 0) {
      modelNames = modelNames.filter((name) => appInfo.allowedModelIds.includes(name));
    }

    const data = modelNames.map((name) => {
      const vmConfig = configManager.getVirtualModelConfig(name);
      return {
        type: 'model',
        id: name,
        display_name: name,
        created_at: vmConfig ? vmConfig.createdAt.toISOString() : new Date(0).toISOString(),
      };
    });

    res.json({ type: 'list', data });
  } catch (error) {
    handleError(error, res, 'anthropic');
  }
});

export { router as anthropicRouter };
