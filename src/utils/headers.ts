// src/utils/headers.ts — 请求头脱敏与格式转换

import type { Response } from 'express';
import type { HttpHeaders } from '@/types';

// ==================== 请求头脱敏 ====================

/** 需要脱敏的请求头名称（小写） */
const SENSITIVE_HEADERS = new Set(['authorization', 'x-api-key', 'cookie', 'x-goog-api-key']);

/** 请求头值类型 */
type HeaderValue = string | string[] | undefined;

/**
 * 提取并脱敏请求头快照
 * 脱敏规则：敏感头仅保留前缀（前11位），其余完整保留
 */
export function sanitizeHeaders(headers: Record<string, HeaderValue>): Record<string, HeaderValue> {
  const result: Record<string, HeaderValue> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.has(key.toLowerCase()) && typeof value === 'string') {
      result[key] = value.length > 11 ? `${value.slice(0, 11)}...` : value;
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ==================== Express 响应头转换 ====================

/**
 * 将 Express OutgoingHttpHeaders 转为 HttpHeaders
 * 数值型头（如 Content-Length）转为字符串
 */
export function expressHeadersToRecord(headers: ReturnType<Response['getHeaders']>): HttpHeaders {
  const result: HttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    result[key] = typeof value === 'number' ? String(value) : value;
  }
  return result;
}
