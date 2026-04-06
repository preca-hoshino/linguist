// src/api/index.ts — 用户 API 格式路由聚合

import type { Request } from 'express';
import { Router } from 'express';
import { createCachedLoggerFactory, createLogger, logColors } from '@/utils';
import { anthropicRouter, extractApiKey as claudeExtractApiKey } from './anthropic';
import { extractApiKey as geminiExtractApiKey, geminiRouter } from './gemini';
import { extractApiKey as openaiCompatExtractApiKey, openaiCompatRouter } from './openaicompat';

const logger = createLogger('API', logColors.bold + logColors.white);

// ==================== 格式专属 Logger ====================

/**
 * 按 userFormat 获取对应的请求日志 Logger
 * 未注册的格式自动生成 'API:<format>' 标签
 */
export const getFormatLogger: ReturnType<typeof createCachedLoggerFactory> = createCachedLoggerFactory(
  {
    openaicompat: { label: 'API:OpenAI', color: logColors.bold + logColors.white },
    gemini: { label: 'API:Gemini', color: logColors.bold + logColors.blue },
    claude: { label: 'API:Anthropic', color: logColors.bold + logColors.magenta },
  },
  'API',
  logColors.bold + logColors.white,
);

/** 从 HTTP 请求中提取 API Key 的函数（各用户格式使用不同的提取策略，如 Bearer token 或 query 参数） */
type ApiKeyExtractor = (req: Request) => string | undefined;

// ==================== API Key 提取器注册中心 ====================

const apiKeyExtractors: Record<string, ApiKeyExtractor> = {};

function registerApiKeyExtractor(format: string, extractor: ApiKeyExtractor): void {
  apiKeyExtractors[format] = extractor;
  logger.debug({ format }, 'API key extractor registered');
}

/**
 * 按用户格式获取 API Key 提取器
 * 找不到时抛出错误，避免新增格式忘记注册时静默使用错误的提取逻辑
 */
export function getApiKeyExtractor(format: string): ApiKeyExtractor {
  const extractor = apiKeyExtractors[format];
  if (!extractor) {
    throw new Error(`No API key extractor registered for format: ${format}`);
  }
  return extractor;
}

// ==================== 注册各格式提取器 ====================
registerApiKeyExtractor('openaicompat', openaiCompatExtractApiKey);
registerApiKeyExtractor('gemini', geminiExtractApiKey);
registerApiKeyExtractor('anthropic', claudeExtractApiKey);

// ==================== 路由聚合 ====================

const apiRouter: Router = Router();

// 挂载各格式路由（每种格式自行定义路径前缀）
apiRouter.use(openaiCompatRouter);
apiRouter.use(geminiRouter);
apiRouter.use(anthropicRouter);

export { apiRouter };
