// src/db/mcp-logs/types.ts — MCP 日志类型定义

/** 日志方向 */
export type McpLogDirection = 'inbound' | 'outbound';

/** 数据库行类型 */
export interface McpLogRow {
  [key: string]: unknown;
  id: string;
  virtual_mcp_id: string | null;
  provider_mcp_id: string | null;
  app_id: string | null;
  session_id: string;
  direction: McpLogDirection;
  method: string;
  params: Record<string, unknown>;
  result: Record<string, unknown>;
  error: Record<string, unknown> | null;
  duration_ms: number;
  created_at: string;
}

/** 创建输入 */
export interface McpLogCreateInput {
  id: string;
  virtual_mcp_id?: string | undefined;
  provider_mcp_id?: string | undefined;
  app_id?: string | undefined;
  session_id?: string | undefined;
  direction: McpLogDirection;
  method: string;
  params?: Record<string, unknown> | undefined;
  result?: Record<string, unknown> | undefined;
  error?: Record<string, unknown> | undefined;
  duration_ms?: number | undefined;
}
