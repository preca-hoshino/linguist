// src/socket.ts — WebSocket Upgrade 占位处理器（V2 网关，待实现）

import { createLogger, logColors } from '@/utils';

const logger = createLogger('WebSocket', logColors.cyan);

// TODO: Phase 3 实现
// - HTTP → WebSocket 协议升级处理
// - 从 URL query param 或首帧中提取 API Key 完成鉴权
// - 创建 ModelWsContext，分发到 wsEngine.handleSession()
// - 心跳检测与连接回收

/**
 * 为 HTTP 服务绑定 WebSocket Upgrade 处理（V2 网关占位）
 *
 * 预期调用方式：在 src/index.ts 中 server 启动后调用
 * ```ts
 * const server = app.listen(PORT);
 * setupWebSocket(server);
 * ```
 */
export function setupWebSocket(_server: unknown): void {
  logger.info('WebSocket V2 gateway setup deferred to Phase 3');
  // Phase 3 实现
}
