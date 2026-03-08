// src/api/index.ts — 用户 API 格式路由聚合

import type { Request } from 'express';
import { Router } from 'express';
import { openaiCompatRouter, extractApiKey as openaiCompatExtractApiKey } from './openaicompat';
import { geminiRouter, extractApiKey as geminiExtractApiKey } from './gemini';
import { createLogger, logColors } from '../utils';
import type { Logger } from '../utils';

const logger = createLogger('API', logColors.bold + logColors.white);

// ==================== 格式专属 Logger ====================

const FORMAT_LOG_SPEC: Record<string, { label: string; color: string }> = {
  openaicompat: { label: 'API:OpenAI', color: logColors.bold + logColors.white },
  gemini: { label: 'API:Gemini', color: logColors.bold + logColors.blue },
};

const formatLoggerCache: Record<string, Logger> = {};

/**
 * 按 userFormat 获取对应的请求日志 Logger
 * 未在 FORMAT_LOG_SPEC 中注册的格式自动生成默认标签
 */
export function getFormatLogger(userFormat: string): Logger {
  if (formatLoggerCache[userFormat] === undefined) {
    const spec = FORMAT_LOG_SPEC[userFormat];
    const label = spec !== undefined ? spec.label : `API:${userFormat}`;
    const color = spec !== undefined ? spec.color : logColors.bold + logColors.white;
    formatLoggerCache[userFormat] = createLogger(label, color);
  }
  return formatLoggerCache[userFormat];
}

/** 从 HTTP 请求中提取 API Key 的函数（各用户格式使用不同的提取策略，如 Bearer token 或 query 参数） */
export type ApiKeyExtractor = (req: Request) => string | undefined;

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

// ==================== 路由聚合 ====================

const apiRouter = Router();

// 挂载各格式路由（每种格式自行定义路径前缀）
apiRouter.use(openaiCompatRouter);
apiRouter.use(geminiRouter);

export { apiRouter };
