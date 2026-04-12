// src/mcp/index.ts — MCP 代理网关出口

import { createLogger, logColors } from '@/utils';
import { mcpConnectionManager } from './providers/connection-manager';

export { handleMcpMessage, handleMcpSseConnect } from './virtual/server';

const logger = createLogger('McpGateway', logColors.blue);

/** 初始化 MCP 网关模块（暂留钩子结构） */
export function initMcpGateway(): void {
  logger.info('MCP Gateway module initialized');
}

/** 优雅关闭 MCP 网关服务并断开所有 Provider */
export async function shutdownMcpGateway(): Promise<void> {
  logger.info('Shutting down MCP Gateway...');
  await mcpConnectionManager.disconnectAll();
}
