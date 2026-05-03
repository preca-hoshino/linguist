// src/api/ws/realtime/index.ts — OpenAI Realtime API WebSocket 端点（V2 网关占位）

import type { Request } from 'express';
import { Router } from 'express';
import { createLogger, logColors } from '@/utils';

const logger = createLogger('API:WS:Realtime', logColors.bold + logColors.cyan);

// TODO: Phase 3 实现
// - 解析 WebSocket Upgrade 请求（从 URL query param 或首帧提取 API Key）
// - 完成鉴权（与 HTTP 管线一致的 apiKeyAuth 逻辑）
// - 获取 RoutedModelContext 路由信息
// - 分发到 wsEngine.handleSession() 建立长连接
// - 兼容 OpenAI Realtime API 协议: ws://host/v1/realtime?model=gpt-4o-realtime-preview

export const realtimeRouter: Router = Router();

/** 从 WebSocket 升级请求中提取 API Key */
export function extractApiKey(_req: Request): string | undefined {
  logger.debug('WebSocket API key extraction deferred to Phase 3');
  return undefined;
}

logger.info('Realtime WebSocket endpoint registered (placeholder)');
