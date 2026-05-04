// src/middleware/common/request-id.ts — 请求唯一 ID 生成中间件（占位）

import type { ModelHttpContext } from '@/types';
import { v4 as uuidv4 } from '@/utils/crypto';

// TODO: Phase 3 实现
// - 从请求头 X-Request-ID 提取（若客户端提供），否则生成 UUID v4
// - 注入到 ModelHttpContext.id
// - 将 request-id 注入响应头，实现全链路追踪

/**
 * Request ID 中间件
 *
 * 为每个入站请求生成或继承唯一标识符，写入 ModelHttpContext.id。
 * 优先使用客户端传入的 X-Request-ID，否则自动生成 UUID v4。
 */
export function requestId(ctx: ModelHttpContext): void {
  // Phase 3 实现: 从 ctx.http.headers 提取或生成
  ctx.id = ctx.id || uuidv4();
}
