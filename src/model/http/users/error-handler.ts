// src/users/error-handler.ts — 用户错误格式化入口

import type { Response } from 'express';
import { GatewayError } from '@/utils/errors';
import { createLogger, logColors } from '@/utils/logger';
import { buildAnthropicErrorBody } from './anthropic/error-formatting';
import { buildGeminiErrorBody } from './gemini/error-formatting';
import { buildOpenAICompatErrorBody } from './openaicompat/error-formatting';
import type { ErrorResponsePayload } from './types';

const logger = createLogger('Error', logColors.bold + logColors.red);

/** 错误响应体构建函数签名 */
type ErrorBodyBuilder = (err: unknown) => ErrorResponsePayload;

/** 已注册的用户格式错误体构建器 */
const errorBodyBuilders: Record<string, ErrorBodyBuilder> = {};

/** 注册用户格式错误体构建器 */
export function registerErrorBodyBuilder(format: string, builder: ErrorBodyBuilder): void {
  errorBodyBuilders[format] = builder;
}

/**
 * 构建错误响应载荷（不发送、不记录日志）
 * 用于审计场景——获取与 handleError 完全一致的响应体，写入 ctx.audit.userResponse
 *
 * @param err     捕获的异常
 * @param format  用户格式标识（如 'openaicompat'、'gemini'），省略时使用默认格式
 */
export function buildErrorResponseBody(err: unknown, format?: string): ErrorResponsePayload {
  const builder =
    format === undefined ? buildOpenAICompatErrorBody : (errorBodyBuilders[format] ?? buildOpenAICompatErrorBody);
  return builder(err);
}

/**
 * 统一错误处理函数
 * 记录日志并将错误转换为标准化的 JSON 响应发送给客户端
 *
 * @param err     捕获的异常
 * @param res     Express 响应对象
 * @param format  用户格式标识（如 'openaicompat'、'gemini'），省略时使用默认格式
 */
export function handleError(err: unknown, res: Response, format?: string): void {
  // 日志记录
  if (err instanceof GatewayError) {
    logger.warn({ errorCode: err.errorCode, statusCode: err.statusCode, format }, err.message);
  } else {
    logger.error({ err, format }, 'Unexpected error');
  }

  // 构建并发送格式化错误响应
  const { status, body } = buildErrorResponseBody(err, format);
  res.status(status).json(body);
}

// ==================== 注册内置错误体构建器 ====================

registerErrorBodyBuilder('openaicompat', buildOpenAICompatErrorBody);
registerErrorBodyBuilder('gemini', buildGeminiErrorBody);
registerErrorBodyBuilder('anthropic', buildAnthropicErrorBody);
