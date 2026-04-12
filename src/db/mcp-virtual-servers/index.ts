// src/db/mcp-virtual-servers/index.ts — 虚拟 MCP 模块导出
export {
  createMcpVirtualServer,
  deleteMcpVirtualServer,
  getMcpVirtualServerById,
  listMcpVirtualServers,
  updateMcpVirtualServer,
} from './queries';
export type {
  McpVirtualServerCreateInput,
  McpVirtualServerRow,
  McpVirtualServerUpdateInput,
} from './types';
