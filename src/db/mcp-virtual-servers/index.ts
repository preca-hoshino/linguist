// src/db/mcp-virtual-servers/index.ts — 虚拟 MCP 模块导出
export {
  createVirtualMcp,
  deleteVirtualMcp,
  getVirtualMcpById,
  getVirtualMcpByName,
  listVirtualMcps,
  updateVirtualMcp,
} from './queries';
export type {
  VirtualMcpConfig,
  VirtualMcpCreateInput,
  VirtualMcpRow,
  VirtualMcpUpdateInput,
} from './types';
