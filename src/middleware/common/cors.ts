// src/middleware/common/cors.ts — 跨域资源共享中间件（占位）

import type { Middleware } from '../types';

// TODO: Phase 3 实现
// - 从 ConfigManager 读取允许的 Origin 白名单
// - 为 HTTP API 和 WebSocket Upgrade 请求设置 CORS 头
// - 处理 OPTIONS 预检请求
// - 支持 credentials 模式 (Access-Control-Allow-Credentials)

/**
 * CORS 中间件
 *
 * 为入站 HTTP 请求设置跨域响应头，确保浏览器端 SDK 可正常调用。
 * 配置来源：ConfigManager → cors.allowed_origins
 */
export function cors(): Middleware {
  return () => {
    // Phase 3 实现
  };
}
