// src/db/request-logs/write.ts — 请求日志写入操作
// markProcessing / markCompleted / markError + 私有辅助函数

import { db } from '../client';
import type { GatewayContext, RoutedGatewayContext } from '../../types';
import { createLogger, logColors, GatewayError } from '../../utils';
import type { ErrorType } from './types';

const logger = createLogger('RequestLog', logColors.bold + logColors.blue);

// ==================== 写入函数 ====================

/**
 * 创建请求日志（状态 = processing）并记录路由信息
 * 在路由完成、即将调用提供商前触发，fire-and-forget
 * 使用 RoutedGatewayContext 确保路由字段已全部填充
 */
export async function markProcessing(ctx: RoutedGatewayContext): Promise<void> {
  try {
    await db.query(
      `INSERT INTO request_logs
         (id, status, api_key_prefix, ip, is_stream, request_model, routed_model, provider_kind, provider_id, timing, gateway_context)
       VALUES ($1, 'processing', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        ctx.id,
        ctx.apiKeyPrefix ?? null,
        ctx.ip,
        ctx.stream ?? null,
        ctx.requestModel,
        ctx.route.model,
        ctx.route.providerKind,
        ctx.route.providerId,
        JSON.stringify(ctx.timing),
        JSON.stringify(buildCtxSnapshot(ctx)),
      ],
    );
    logger.info(
      { requestId: ctx.id, model: ctx.requestModel, routedModel: ctx.route.model, provider: ctx.route.providerKind },
      'Request processing [processing]',
    );
  } catch (err) {
    logger.error({ err, requestId: ctx.id }, 'Failed to mark request as processing');
  }
}

/**
 * 更新状态为 completed（请求成功完成）
 * 直接从 GatewayContext 提取所有审计数据，一次性写入
 */
export async function markCompleted(ctx: GatewayContext): Promise<void> {
  const { promptTokens, completionTokens, totalTokens, cachedTokens, reasoningTokens } = extractUsage(ctx);
  try {
    await db.query(
      `UPDATE request_logs
       SET status = 'completed',
           routed_model = $2,
           provider_kind = $3,
           provider_id = $4,
           timing = $5,
           prompt_tokens = $6,
           completion_tokens = $7,
           total_tokens = $8,
           cached_tokens = $9,
           reasoning_tokens = $10,
           gateway_context = $11,
           is_stream = $12
       WHERE id = $1`,
      [
        ctx.id,
        ctx.route?.model ?? null,
        ctx.route?.providerKind ?? null,
        ctx.route?.providerId ?? null,
        JSON.stringify(ctx.timing),
        promptTokens ?? null,
        completionTokens ?? null,
        totalTokens ?? null,
        cachedTokens ?? null,
        reasoningTokens ?? null,
        JSON.stringify(buildCtxSnapshot(ctx)),
        ctx.stream ?? null,
      ],
    );
    const duration = ctx.timing.end !== undefined ? ctx.timing.end - ctx.timing.start : undefined;
    logger.info(
      {
        requestId: ctx.id,
        tokens: totalTokens,
        promptTokens,
        completionTokens,
        cachedTokens,
        reasoningTokens,
        duration: duration !== undefined ? `${String(duration)}ms` : undefined,
      },
      'Request completed [completed]',
    );
  } catch (err) {
    logger.error({ err, requestId: ctx.id }, 'Failed to mark request as completed');
  }
}

/**
 * 记录请求失败（UPSERT）
 *
 * 使用 INSERT ... ON CONFLICT DO UPDATE 确保即使路由前的错误（auth / validation / routing）
 * 也能正确落库——此时 markProcessing 尚未执行，不存在对应行。
 */
export async function markError(ctx: GatewayContext, err: unknown): Promise<void> {
  const errorCode = err instanceof GatewayError ? err.errorCode : 'internal_error';
  const errorType = inferErrorType(errorCode);
  try {
    await db.query(
      `INSERT INTO request_logs
         (id, status, api_key_prefix, ip, is_stream, request_model,
          routed_model, provider_kind, provider_id,
          error_message, error_code, error_type, timing, gateway_context)
       VALUES ($1, 'error', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (id) DO UPDATE SET
         status = 'error',
         routed_model = EXCLUDED.routed_model,
         provider_kind = EXCLUDED.provider_kind,
         provider_id = EXCLUDED.provider_id,
         error_message = EXCLUDED.error_message,
         error_code = EXCLUDED.error_code,
         error_type = EXCLUDED.error_type,
         timing = EXCLUDED.timing,
         gateway_context = EXCLUDED.gateway_context,
         is_stream = EXCLUDED.is_stream`,
      [
        ctx.id,
        ctx.apiKeyPrefix ?? null,
        ctx.ip,
        ctx.stream ?? null,
        ctx.requestModel,
        ctx.route?.model ?? null,
        ctx.route?.providerKind ?? null,
        ctx.route?.providerId ?? null,
        ctx.error ?? null,
        errorCode,
        errorType,
        JSON.stringify(ctx.timing),
        JSON.stringify(buildCtxSnapshot(ctx)),
      ],
    );
    logger.warn({ requestId: ctx.id, errorCode, errorMessage: ctx.error }, 'Request failed [error]');
  } catch (dbErr) {
    logger.error({ err: dbErr, requestId: ctx.id }, 'Failed to mark request as error');
  }
}

// ==================== 私有辅助函数 ====================

/**
 * 从 GatewayContext 提取 usage 信息
 * 兼容 chat（含 completion_tokens）和 embedding（无 completion_tokens）两种响应类型
 */
function extractUsage(ctx: GatewayContext): {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
} {
  const response = ctx.response;
  if (response?.usage === undefined) {
    return {};
  }
  const { usage } = response;
  const result: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    cachedTokens?: number;
    reasoningTokens?: number;
  } = {
    promptTokens: usage.prompt_tokens,
    totalTokens: usage.total_tokens,
  };
  if ('completion_tokens' in usage) {
    result.completionTokens = usage.completion_tokens;
  }
  if ('cached_tokens' in usage && usage.cached_tokens !== undefined) {
    result.cachedTokens = usage.cached_tokens;
  }
  if ('reasoning_tokens' in usage && usage.reasoning_tokens !== undefined) {
    result.reasoningTokens = usage.reasoning_tokens;
  }
  return result;
}

/**
 * 根据 errorCode 推断错误类型分类
 */
function inferErrorType(errorCode: string): ErrorType {
  const code = errorCode.toLowerCase();

  switch (code) {
    case 'rate_limit_exceeded':
    case 'quota_exceeded':
      return 'rate_limit';
    case 'provider_timeout':
      return 'timeout';
    case 'authentication_error':
    case 'unauthorized':
    case 'invalid_api_key':
    case 'permission_denied':
    case 'insufficient_balance':
      return 'auth_error';
    case 'invalid_request':
    case 'invalid_parameter':
    case 'missing_model':
    case 'model_type_mismatch':
    case 'capability_not_supported':
    case 'content_filtered':
    case 'model_not_found':
    case 'not_found':
      return 'invalid_request';
    case 'internal_error':
    case 'route_error':
      return 'internal_error';
    case 'provider_error':
    case 'provider_unavailable':
    case 'no_backend_available':
    case 'no_available_backend':
    case 'provider_response_invalid':
      return 'provider_error';
    default:
      break;
  }

  // 关键词回退匹配（兼容旧错误码）
  if (code.includes('rate_limit') || code.includes('quota') || code.includes('throttl')) {
    return 'rate_limit';
  }
  if (code.includes('timeout') || code.includes('timed_out') || code.includes('deadline')) {
    return 'timeout';
  }
  if (code.includes('auth') || code.includes('api_key') || code.includes('permission') || code.includes('forbidden')) {
    return 'auth_error';
  }
  if (code.includes('invalid_request') || code.includes('bad_request') || code.includes('validation')) {
    return 'invalid_request';
  }
  return 'provider_error';
}

/**
 * 构建 GatewayContext 完整快照（唯一审计数据源）
 *
 * 包含完整生命周期数据：路由、请求/响应、四次交换审计、计时、错误等。
 * 仅排除敏感字段：apiKey（原始密钥）、providerConfig（含厂商 apiKey）。
 */
function buildCtxSnapshot(ctx: GatewayContext): Record<string, unknown> {
  return {
    id: ctx.id,
    ip: ctx.ip,
    apiKeyPrefix: ctx.apiKeyPrefix,
    userFormat: ctx.userFormat,
    http: ctx.http,
    requestModel: ctx.requestModel,
    route: ctx.route
      ? {
          model: ctx.route.model,
          modelType: ctx.route.modelType,
          providerKind: ctx.route.providerKind,
          providerId: ctx.route.providerId,
          providerName: ctx.route.providerConfig.name,
          strategy: ctx.route.strategy,
          capabilities: ctx.route.capabilities,
        }
      : undefined,
    stream: ctx.stream,
    request: ctx.request,
    response: ctx.response,
    audit: {
      userRequest: ctx.audit.userRequest,
      providerRequest: ctx.audit.providerRequest,
      providerResponse: ctx.audit.providerResponse,
      userResponse: ctx.audit.userResponse,
    },
    timing: ctx.timing,
    error: ctx.error,
    providerError: ctx.providerError,
  };
}
