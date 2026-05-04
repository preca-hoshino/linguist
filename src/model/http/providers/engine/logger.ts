// src/model/http/providers/engine/logger.ts — Provider 动态日志器

import { createCachedLoggerFactory, logColors } from '@/utils';
import type { Logger } from '@/utils';

/** 根据 providerKind 获取（或创建）对应的 Logger */
export const getProviderLogger: (key: string) => Logger = createCachedLoggerFactory(
  {
    deepseek: { label: 'Provider:DeepSeek', color: logColors.bold + logColors.green },
    gemini: { label: 'Provider:Gemini', color: logColors.bold + logColors.yellow },
    volcengine: { label: 'Provider:VolcEngine', color: logColors.bold + logColors.magenta },
    copilot: { label: 'Provider:Copilot', color: logColors.bold + logColors.cyan },
    mimo: { label: 'Provider:MiMo', color: logColors.bold + logColors.blue },
  },
  'Provider',
  logColors.bold + logColors.white,
);
