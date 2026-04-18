// src/db/request-logs/write.ts — 请求日志写入操作
// markProcessing / markCompleted / markError + 私有辅助函数

import { calculatePostBillingCost, lookupPricingTiers } from '@/db/billing';
import { db } from '@/db/client';
import type { CostBreakdown, ModelHttpContext, RoutedModelHttpContext } from '@/types';
import { createLogger, GatewayError, logColors } from '@/utils';
import type { ErrorType } from './types';

const logger = createLogger('RequestLog', logColors.bold + logColors.blue);

// ==================== 写入函数 ====================

/**
 * 创建请求日志（状态 = processing）并记录路由信息
 * 在路由完成、即将调用提供商前触发，fire-and-forget
 * 使用 RoutedModelHttpContext 确保路由字段已全部填充
 */
export async function markProcessing(ctx: RoutedModelHttpContext): Promise<void> {
  try {
    // 写入基础热数据
    await db.query(
      `INSERT INTO request_logs
         (id, status, app_id, ip, is_stream, request_model, routed_model, provider_kind, provider_id)
       VALUES ($1, 'processing', $2, $3, $4, $5, $6, $7, $8)`,
      [
        ctx.id,
        ctx.appId ?? null,
        ctx.ip,
        ctx.stream ?? null,
        ctx.requestModel,
        ctx.route.model,
        ctx.route.providerKind,
        ctx.route.providerId,
      ],
    );
    // 同步写入冷数据详情
    await db.query(
      `INSERT INTO request_logs_details
         (id, timing, gateway_context)
       VALUES ($1, $2, $3)`,
      [ctx.id, JSON.stringify(ctx.timing), JSON.stringify(buildCtxSnapshot(ctx))],
    );
    logger.info(
      { requestId: ctx.id, model: ctx.requestModel, routedModel: ctx.route.model, provider: ctx.route.providerKind },
      'Request processing [processing]',
    );
  } catch (error) {
    logger.error({ err: error, requestId: ctx.id }, 'Failed to mark request as processing');
  }
}

/**
 * 更新状态为 completed（请求成功完成）
 * 直接从 ModelHttpContext 提取所有审计数据，一次性写入
 */
export async function markCompleted(ctx: ModelHttpContext): Promise<void> {
  const { promptTokens, completionTokens, totalTokens, cachedTokens, reasoningTokens } = extractUsage(ctx);

  // 后置计费：查询阶梯配置 → 计算费用
  let calculatedCost = 0;
  let costBreakdown: CostBreakdown | null = null;

  if (ctx.route && promptTokens !== undefined) {
    const tiers = await lookupPricingTiers(ctx.route.providerId, ctx.route.model);
    const billingResult = calculatePostBillingCost(tiers, promptTokens, completionTokens ?? 0, cachedTokens ?? 0);
    if (billingResult.status === 'success') {
      calculatedCost = billingResult.cost;
      costBreakdown = billingResult.breakdown;
    }
  }

  try {
    // 更新主表热数据
    await db.query(
      `UPDATE request_logs
       SET status = 'completed',
           routed_model = $2,
           provider_kind = $3,
           provider_id = $4,
           prompt_tokens = $5,
           completion_tokens = $6,
           total_tokens = $7,
           cached_tokens = $8,
           reasoning_tokens = $9,
           is_stream = $10,
           calculated_cost = $11
       WHERE id = $1`,
      [
        ctx.id,
        ctx.route?.model ?? null,
        ctx.route?.providerKind ?? null,
        ctx.route?.providerId ?? null,
        promptTokens ?? null,
        completionTokens ?? null,
        totalTokens ?? null,
        cachedTokens ?? null,
        reasoningTokens ?? null,
        ctx.stream ?? null,
        calculatedCost,
      ],
    );

    // 更新详情冷数据
    await db.query(
      `UPDATE request_logs_details
       SET timing = $2,
           gateway_context = $3,
           cost_breakdown = $4
       WHERE id = $1`,
      [
        ctx.id,
        JSON.stringify(ctx.timing),
        JSON.stringify(buildCtxSnapshot(ctx)),
        costBreakdown === null ? null : JSON.stringify(costBreakdown),
      ],
    );

    const duration = ctx.timing.end === undefined ? undefined : ctx.timing.end - ctx.timing.start;
    logger.info(
      {
        requestId: ctx.id,
        tokens: totalTokens,
        promptTokens,
        completionTokens,
        cachedTokens,
        reasoningTokens,
        cost: calculatedCost > 0 ? calculatedCost : undefined,
        duration: duration === undefined ? undefined : `${String(duration)}ms`,
      },
      'Request completed [completed]',
    );
  } catch (error) {
    logger.error({ err: error, requestId: ctx.id }, 'Failed to mark request as completed');
  }
}

/**
 * 记录请求失败（模拟 UPSERT）
 *
 * 因为使用了分区表无法简单的跨两列提供单纯的主键约束 (ON CONFLICT (id))，
 * 故改用先 UPDATE 若不存在再 INSERT 来确保即便路由前崩溃的请求也能被记录到底库中。
 */
export async function markError(ctx: ModelHttpContext, err: unknown): Promise<void> {
  const errorCode = err instanceof GatewayError ? err.errorCode : 'internal_error';
  const errorType = inferErrorType(errorCode);

  // 如果没有成功的路由（比如模型不存在、未通过鉴权），直接跳过不录入数据库，
  // 防止产生大量垃圾日志（如被攻击或填错模型）
  if (!ctx.route) {
    logger.warn(
      { requestId: ctx.id, errorCode, errorMessage: ctx.error },
      'Request failed before routing, ignored for database [error]',
    );
    return;
  }

  try {
    const updateRes = await db.query(
      `UPDATE request_logs
       SET status = 'error',
           routed_model = COALESCE($2, routed_model),
           provider_kind = COALESCE($3, provider_kind),
           provider_id = COALESCE($4, provider_id),
           error_message = $5,
           error_code = $6,
           error_type = $7,
           is_stream = COALESCE($8, is_stream)
       WHERE id = $1`,
      [
        ctx.id,
        ctx.route.model,
        ctx.route.providerKind,
        ctx.route.providerId,
        ctx.error ?? null,
        errorCode,
        errorType,
        ctx.stream ?? null,
      ],
    );

    if ((updateRes.rowCount ?? 0) > 0) {
      // 记录已存在，只更新从表
      await db.query(
        `UPDATE request_logs_details
         SET timing = $2, gateway_context = $3
         WHERE id = $1`,
        [ctx.id, JSON.stringify(ctx.timing), JSON.stringify(buildCtxSnapshot(ctx))],
      );
    } else {
      // 记录尚不存在（路由通过但 markProcessing 写入异常等极端情况），执行 INSERT
      await db.query(
        `INSERT INTO request_logs
           (id, status, app_id, ip, is_stream, request_model,
            routed_model, provider_kind, provider_id,
            error_message, error_code, error_type)
         VALUES ($1, 'error', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          ctx.id,
          ctx.appId ?? null,
          ctx.ip,
          ctx.stream ?? null,
          ctx.requestModel,
          ctx.route.model,
          ctx.route.providerKind,
          ctx.route.providerId,
          ctx.error ?? null,
          errorCode,
          errorType,
        ],
      );

      await db.query(
        `INSERT INTO request_logs_details
           (id, timing, gateway_context)
         VALUES ($1, $2, $3)`,
        [ctx.id, JSON.stringify(ctx.timing), JSON.stringify(buildCtxSnapshot(ctx))],
      );
    }

    logger.warn({ requestId: ctx.id, errorCode, errorMessage: ctx.error }, 'Request failed [error]');
  } catch (error) {
    logger.error({ err: error, requestId: ctx.id }, 'Failed to mark request as error');
  }
}

// ==================== 私有辅助函数 ====================

/**
 * 从 ModelHttpContext 提取 usage 信息
 * 兼容 chat（含 completion_tokens）和 embedding（无 completion_tokens）两种响应类型
 */
function extractUsage(ctx: ModelHttpContext): {
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

  const errorMap: Record<string, ErrorType> = {
    rate_limit_exceeded: 'rate_limit',
    quota_exceeded: 'rate_limit',
    provider_timeout: 'timeout',
    authentication_error: 'auth_error',
    unauthorized: 'auth_error',
    invalid_api_key: 'auth_error',
    permission_denied: 'auth_error',
    insufficient_balance: 'auth_error',
    invalid_request: 'invalid_request',
    invalid_parameter: 'invalid_request',
    missing_model: 'invalid_request',
    model_type_mismatch: 'invalid_request',
    capability_not_supported: 'invalid_request',
    content_filtered: 'invalid_request',
    model_not_found: 'invalid_request',
    not_found: 'invalid_request',
    internal_error: 'internal_error',
    route_error: 'internal_error',
    provider_error: 'provider_error',
    provider_unavailable: 'provider_error',
    no_backend_available: 'provider_error',
    no_available_backend: 'provider_error',
    provider_response_invalid: 'provider_error',
  };

  if (errorMap[code]) {
    return errorMap[code];
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
 * 构建 ModelHttpContext 完整快照（唯一审计数据源）
 *
 * 包含完整生命周期数据：路由、请求/响应、四次交换审计、计时、错误等。
 * 仅排除敏感字段：apiKey（原始密钥）、providerConfig（含厂商 apiKey）。
 */
function buildCtxSnapshot(ctx: ModelHttpContext): Record<string, unknown> {
  return {
    id: ctx.id,
    ip: ctx.ip,
    apiKeyName: ctx.apiKeyName,
    appId: ctx.appId,
    appName: ctx.appName,
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
