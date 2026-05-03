// src/middleware/common/logger.ts — 请求日志记录中间件（占位）

import type { Middleware } from '../types';

// TODO: Phase 3 实现
// - 记录每个入站请求的 method、path、status、duration
// - 脱敏处理敏感字段（apiKey → 仅保留前 8 位 + ***）
// - 按 userFormat 使用不同的日志标签和颜色
// - 对接 Winston 结构化日志管道

/**
 * 请求日志记录中间件
 *
 * 在请求处理完成后记录结构化日志，包含：
 * - 请求方法 / 路径 / User-Agent
 * - 响应状态码与耗时
 * - 脱敏后的 API Key 标识
 */
export function requestLogger(): Middleware {
  return () => {
    // Phase 3 实现
  };
}
