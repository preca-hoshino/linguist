// src/middleware/common/error-handler.ts — 全局错误处理中间件（占位）

import type { GatewayError } from '@/utils';

// TODO: Phase 3 实现
// - 统一捕获所有未处理异常（同步 + Promise rejection）
// - 将 GatewayError 映射为标准 HTTP 错误响应格式
// - 根据 userFormat（openaicompat / gemini / claude）输出对应格式的错误体
// - 记录错误日志（含 requestId、stack trace）

/**
 * 全局错误处理中间件
 *
 * 捕获中间件链和路由处理器中抛出的所有异常，
 * 将其规范化为对应协议格式的错误响应。
 *
 * @param err 捕获的异常对象
 * @param _ctx 当前请求上下文
 * @returns 标准化的 HTTP 错误响应载荷
 */
export function errorHandler(err: GatewayError | Error): void {
  // Phase 3 实现
  void err;
}
