// src/utils/response-headers.ts — 响应头注入工具

import type { Response } from 'express';

/** 注入响应头所需的元数据 */
export interface ResponseMeta {
  /** 请求追踪 ID（UUID v4） */
  requestId: string;
  /** 请求入口时间戳（Date.now()） */
  startTime: number;
  /** 网关标识，默认 'Linguist' */
  gateway?: string | undefined;
}

/**
 * 拦截 res.writeHead，统一注入应用层响应头。
 *
 * 调用时机：请求入口处，在任何响应写入之前。
 * 注入的响应头：
 * - X-Request-Id:      请求追踪 ID（与日志/审计 ID 一致）
 * - X-Gateway:         网关标识（默认 'Linguist'）
 * - X-Response-Time-ms: 请求处理耗时（毫秒）
 * - X-RateLimit-*:     预留，当前不设值
 */
export function injectResponseHeaders(res: Response, meta: ResponseMeta): void {
  // 测试 mock 中 res.writeHead 可能不存在，跳过注入
  if (typeof res.writeHead !== 'function') {
    return;
  }

  // biome-ignore lint/suspicious/noExplicitAny: writeHead 多重重载签名，实用类型标注
  const origWriteHead = res.writeHead.bind(res) as (...args: any[]) => Response;

  // biome-ignore lint/suspicious/noExplicitAny: 同上
  res.writeHead = ((...args: any[]): Response => {
    res.setHeader('X-Request-Id', meta.requestId);
    res.setHeader('X-Gateway', meta.gateway ?? 'Linguist');
    res.setHeader('X-Response-Time-ms', String(Date.now() - meta.startTime));
    // X-RateLimit-* 预留，后续从 ctx 读取配额回填
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    return origWriteHead(...args);
  }) as typeof res.writeHead;
}
