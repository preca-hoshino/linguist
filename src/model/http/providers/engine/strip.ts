// src/model/http/providers/engine/strip.ts — 参数剥离与 Body 重写

import type { InternalChatRequest, InternalEmbeddingRequest } from '@/types';
import { createLogger, logColors } from '@/utils';

// ========== 日志器 ==========

/** 模块级剥离日志器 */
const stripLogger = createLogger('Provider:Strip', logColors.bold + logColors.gray);

// ========== 可过滤参数白名单 ==========

/**
 * Chat 请求中可按 supported_parameters 声明剥离的调优参数列表
 *
 * ⚠️ 必须与 admin/model/provider-models.ts 中的 CHAT_PARAMETERS 白名单保持同步。
 * 新增参数需同时满足：
 *   1. 存在于 InternalChatRequest 类型定义中
 *   2. 加入此常量
 *   3. 加入 admin 白名单 CHAT_PARAMETERS
 */
export const FILTERABLE_CHAT_PARAMS: ReadonlyArray<keyof InternalChatRequest> = [
  'temperature',
  'top_p',
  'top_k',
  'max_tokens',
  'frequency_penalty',
  'presence_penalty',
  'stop',
] as const;

/**
 * Embedding 请求中可按 supported_parameters 声明剥离的调优参数列表
 *
 * ⚠️ 必须与 admin/model/provider-models.ts 中的 EMBEDDING_PARAMETERS 白名单保持同步。
 */
export const FILTERABLE_EMBEDDING_PARAMS: ReadonlyArray<keyof InternalEmbeddingRequest> = [
  'dimensions',
  'encoding_format',
] as const;

// ========== 参数剥离函数 ==========

/**
 * 按后端声明的 supported_parameters 静默剥离 InternalChatRequest 中不支持的调优参数
 * 用于在适配器序列化前清理请求，避免不支持的参数被透传到提供商 API
 */
export function stripUnsupportedChatParams(
  req: InternalChatRequest,
  supportedParameters: string[] = [],
  requestId?: string,
): InternalChatRequest {
  // 若后端未声明任何 supported_parameters，不做过滤（向后兼容）
  if (supportedParameters.length === 0) {
    return req;
  }

  const filtered: InternalChatRequest = { ...req };
  const stripped: string[] = [];
  for (const field of FILTERABLE_CHAT_PARAMS) {
    if (!supportedParameters.includes(field as string) && field in filtered) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (filtered as unknown as Record<string, unknown>)[field];
      stripped.push(field as string);
    }
  }
  if (stripped.length > 0) {
    stripLogger.debug(
      { requestId, strippedParams: stripped, supportedParameters },
      '[strip] removed unsupported chat params from request',
    );
  }
  return filtered;
}

/**
 * 按后端声明的 supported_parameters 静默剥离 InternalEmbeddingRequest 中不支持的调优参数
 */
export function stripUnsupportedEmbeddingParams(
  req: InternalEmbeddingRequest,
  supportedParameters: string[] = [],
  requestId?: string,
): InternalEmbeddingRequest {
  if (supportedParameters.length === 0) {
    return req;
  }

  const filtered: InternalEmbeddingRequest = { ...req };
  const stripped: string[] = [];
  for (const field of FILTERABLE_EMBEDDING_PARAMS) {
    if (!supportedParameters.includes(field as string) && field in filtered) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (filtered as unknown as Record<string, unknown>)[field];
      stripped.push(field as string);
    }
  }
  if (stripped.length > 0) {
    stripLogger.debug(
      { requestId, strippedParams: stripped, supportedParameters },
      '[strip] removed unsupported embedding params from request',
    );
  }
  return filtered;
}

// ========== Body 重写 ==========

/**
 * 应用 Body 重写规则（null = 删除字段，字符串 = 覆盖/追加）
 */
export function applyBodyOverrides(
  body: Record<string, unknown>,
  overrides?: Record<string, string | null>,
): Record<string, unknown> {
  if (!overrides || Object.keys(overrides).length === 0) {
    return body;
  }
  const result = { ...body };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete result[key];
    } else {
      result[key] = value;
    }
  }
  return result;
}
