// src/providers/error-mapping/shared.ts — 提供商错误映射共享工具

/** 提供商错误映射结果 */
export interface ProviderErrorInfo {
  /** 映射后的网关 HTTP 状态码（可能与提供商原始状态码不同，如 500→502） */
  gatewayStatusCode: number;
  /** 映射后的网关统一错误码 */
  gatewayErrorCode: string;
  /** 提供商原始错误码（从响应体中解析，如 "RateLimitExceeded.EndpointRPMExceeded"） */
  providerErrorCode?: string | undefined;
  /** 面向用户的错误消息（脱敏后，不含提供商名称） */
  message: string;
}

export function tryParseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

/** 根据 HTTP 状态码回退到通用网关错误码 */
export function fallbackByStatus(httpStatus: number): { gatewayStatusCode: number; gatewayErrorCode: string } {
  if (httpStatus === 401) {
    return { gatewayStatusCode: 401, gatewayErrorCode: 'authentication_error' };
  }
  if (httpStatus === 403) {
    return { gatewayStatusCode: 403, gatewayErrorCode: 'permission_denied' };
  }
  if (httpStatus === 404) {
    return { gatewayStatusCode: 404, gatewayErrorCode: 'model_not_found' };
  }
  if (httpStatus === 429) {
    return { gatewayStatusCode: 429, gatewayErrorCode: 'rate_limit_exceeded' };
  }
  if (httpStatus >= 500) {
    return { gatewayStatusCode: 502, gatewayErrorCode: 'provider_error' };
  }
  if (httpStatus === 400) {
    return { gatewayStatusCode: 400, gatewayErrorCode: 'invalid_request' };
  }
  return { gatewayStatusCode: httpStatus, gatewayErrorCode: 'provider_error' };
}

/** 从 Record 中提取字符串字段（安全转换，避免 [object Object]） */
export function extractString(obj: Record<string, unknown>, key: string): string | undefined {
  const val = obj[key];
  if (typeof val === 'string') {
    return val;
  }
  if (typeof val === 'number' || typeof val === 'boolean') {
    return String(val);
  }
  return undefined;
}

/** 从 JSON 解析结果中提取 error 对象 */
export function extractErrorObj(parsed: unknown): Record<string, unknown> | null {
  if (parsed !== null && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    const err = obj['error'];
    if (err !== null && err !== undefined && typeof err === 'object') {
      return err as Record<string, unknown>;
    }
  }
  return null;
}
