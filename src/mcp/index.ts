// src/mcp/index.ts — MCP 网关模块出口（占位）

// TODO: Phase 4
// - 导出 virtual 层的核心类
// - 负责整体 MCP Server 阵列的生命周期启动与卸载

import { createLogger, logColors } from '@/utils';

const logger = createLogger('MCP-Virtual', logColors.magenta);

export function initMcpGateway(): void {
  logger.info('MCP Virtual gateway initialization deferred to Phase 4');
  // Phase 4
}
