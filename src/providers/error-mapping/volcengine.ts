// src/providers/error-mapping/volcengine.ts — 火山引擎错误映射
//
// 火山引擎使用 OpenAI 兼容错误格式（扩展了 code 字段为点分构造）：
// { "error": { "message": "...", "type": "BadRequest", "code": "InvalidParameter" } }

import type { ProviderErrorInfo } from './shared';
import { tryParseJson, fallbackByStatus, extractString, extractErrorObj } from './shared';

/** Volcengine 错误码前缀/关键词 → 网关错误码 */
const VOLCENGINE_CODE_PATTERNS: { pattern: RegExp; gatewayErrorCode: string }[] = [
  // 内容安全
  { pattern: /SensitiveContentDetected/i, gatewayErrorCode: 'content_filtered' },
  { pattern: /RiskDetection/i, gatewayErrorCode: 'content_filtered' },
  // 认证
  { pattern: /^AuthenticationError$/i, gatewayErrorCode: 'authentication_error' },
  { pattern: /^InvalidAccountStatus$/i, gatewayErrorCode: 'authentication_error' },
  // 权限/余额
  { pattern: /^AccessDenied$/i, gatewayErrorCode: 'permission_denied' },
  { pattern: /PermissionDenied/i, gatewayErrorCode: 'permission_denied' },
  { pattern: /^AccountOverdueError$/i, gatewayErrorCode: 'insufficient_balance' },
  { pattern: /ServiceOverdue/i, gatewayErrorCode: 'insufficient_balance' },
  { pattern: /ServiceNotOpen/i, gatewayErrorCode: 'permission_denied' },
  // 速率/配额
  { pattern: /RateLimitExceeded/i, gatewayErrorCode: 'rate_limit_exceeded' },
  { pattern: /RpmRateLimitExceeded/i, gatewayErrorCode: 'rate_limit_exceeded' },
  { pattern: /TpmRateLimitExceeded/i, gatewayErrorCode: 'rate_limit_exceeded' },
  { pattern: /IpmRateLimitExceeded/i, gatewayErrorCode: 'rate_limit_exceeded' },
  { pattern: /^QuotaExceeded$/i, gatewayErrorCode: 'rate_limit_exceeded' },
  { pattern: /^ServerOverloaded$/i, gatewayErrorCode: 'rate_limit_exceeded' },
  { pattern: /^RequestBurstTooFast$/i, gatewayErrorCode: 'rate_limit_exceeded' },
  { pattern: /^SetLimitExceeded$/i, gatewayErrorCode: 'rate_limit_exceeded' },
  { pattern: /^InflightBatchsizeExceeded$/i, gatewayErrorCode: 'rate_limit_exceeded' },
  { pattern: /^AccountRateLimitExceeded$/i, gatewayErrorCode: 'rate_limit_exceeded' },
  // 上下文超限（文档格式：code 直接为 context_length_exceeded）
  { pattern: /^context_length_exceeded$/i, gatewayErrorCode: 'context_length_exceeded' },
  // 上下文/Token 超限（OutofContextError 含图文 token 超限场景）
  { pattern: /^OutofContextError$/i, gatewayErrorCode: 'context_length_exceeded' },
  // 参数校验
  { pattern: /^InvalidParameter/i, gatewayErrorCode: 'invalid_parameter' },
  { pattern: /^MissingParameter/i, gatewayErrorCode: 'invalid_parameter' },
  { pattern: /^InvalidArgument/i, gatewayErrorCode: 'invalid_parameter' },
  { pattern: /^InvalidImageURL/i, gatewayErrorCode: 'invalid_parameter' },
  // 模型不存在
  { pattern: /InvalidEndpointOrModel/i, gatewayErrorCode: 'model_not_found' },
  { pattern: /^ModelNotOpen$/i, gatewayErrorCode: 'model_not_found' },
  { pattern: /^UnsupportedModel$/i, gatewayErrorCode: 'model_not_found' },
  // 内部错误
  { pattern: /^InternalServiceError$/i, gatewayErrorCode: 'provider_error' },
];

export function mapVolcengineError(httpStatus: number, body: string): ProviderErrorInfo {
  const parsed = tryParseJson(body);
  const errorObj = extractErrorObj(parsed);

  const providerErrorCode = errorObj !== null ? extractString(errorObj, 'code') : undefined;
  const message = (errorObj !== null ? extractString(errorObj, 'message') : undefined) ?? body;

  // 优先按提供商错误码匹配
  if (providerErrorCode !== undefined) {
    // 特殊处理：InvalidParameter/OutofContextError 且消息表明是 token/上下文超限（包含图文 token 超限）
    if (
      (/^InvalidParameter/i.test(providerErrorCode) || /^OutofContextError$/i.test(providerErrorCode)) &&
      /token|context|length/i.test(message) &&
      /exceed|too (long|large|many)|max|limit/i.test(message)
    ) {
      return {
        gatewayStatusCode: 400,
        gatewayErrorCode: 'context_length_exceeded',
        providerErrorCode,
        message,
      };
    }

    for (const { pattern, gatewayErrorCode } of VOLCENGINE_CODE_PATTERNS) {
      if (pattern.test(providerErrorCode)) {
        const fb = fallbackByStatus(httpStatus);
        return {
          gatewayStatusCode: fb.gatewayStatusCode,
          gatewayErrorCode,
          providerErrorCode,
          message,
        };
      }
    }
  }

  // 匹配失败时按 HTTP 状态码回退
  const fb = fallbackByStatus(httpStatus);

  // 消息文本兜底：若消息明确表明是 token/上下文超限（含图文超限），强制映射
  if (/token|context|length/i.test(message) && /exceed|too (long|large|many)|max|limit/i.test(message)) {
    return { gatewayStatusCode: 400, gatewayErrorCode: 'context_length_exceeded', providerErrorCode, message };
  }

  // 403 特殊处理：火山引擎 403 多为 OperationDenied 系列
  if (httpStatus === 403) {
    const code = providerErrorCode ?? '';
    if (code.includes('Overdue') || code.includes('overdue')) {
      return { gatewayStatusCode: 403, gatewayErrorCode: 'insufficient_balance', providerErrorCode, message };
    }
    return { gatewayStatusCode: 403, gatewayErrorCode: 'permission_denied', providerErrorCode, message };
  }

  return { gatewayStatusCode: fb.gatewayStatusCode, gatewayErrorCode: fb.gatewayErrorCode, providerErrorCode, message };
}
