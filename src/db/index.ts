// src/db/index.ts — 数据库模块统一出口

export { closePool, createListenClient, db, withTransaction } from './client';
export { generateShortId } from './id-generator';
export type { McpLogCreateInput, McpLogEntry, McpLogListItem, McpLogQuery } from './mcp-logs/index';
export { deleteMcpLogById, getMcpLogById, insertMcpLog, listMcpLogs } from './mcp-logs/index';
export type {
  McpProviderConfig,
  McpProviderCreateInput,
  McpProviderRow,
  McpProviderUpdateInput,
  McpTransportType,
} from './mcp-providers/index';
export {
  createMcpProvider,
  deleteMcpProvider,
  getMcpProviderById,
  listMcpProviders,
  updateMcpProvider,
} from './mcp-providers/index';
export type {
  VirtualMcpConfig,
  VirtualMcpCreateInput,
  VirtualMcpRow,
  VirtualMcpUpdateInput,
} from './mcp-virtual-servers/index';
export {
  createVirtualMcp,
  deleteVirtualMcp,
  getVirtualMcpById,
  listVirtualMcps,
  updateVirtualMcp,
} from './mcp-virtual-servers/index';
export { runMigrations } from './migrate';
export type { RequestLogListItem, RequestLogStatus } from './request-logs/index';
export {
  deleteRequestLogById,
  getRequestLogById,
  markCompleted,
  markError,
  markProcessing,
  queryRequestLogs,
} from './request-logs/index';
export type { StatsBreakdownGroupBy, StatsDimension, StatsInterval, StatsRange } from './stats/index';
export {
  getStatsBreakdown,
  getStatsErrors,
  getStatsOverview,
  getStatsTimeSeries,
  getStatsToday,
  getStatsTokens,
} from './stats/index';
export type { UserUpdateData } from './users/index';
export {
  countUsers,
  createUser,
  deleteUser,
  findByEmail,
  findById as findUserById,
  getUserAvatarData,
  listUsers,
  updateUser,
} from './users/index';
