// src/db/mcp-providers/types.ts — 提供商 MCP 类型定义

/** 传输类型 */
export type McpTransportType = 'stdio' | 'sse' | 'streamable_http';

/** 数据库行类型 */
export interface McpProviderRow {
  [key: string]: unknown;
  id: string;
  name: string;
  transport_type: McpTransportType;
  endpoint_url: string;
  headers: Record<string, string>;
  stdio_command: string;
  stdio_args: string[];
  stdio_env: Record<string, string>;
  api_keys: string[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/** 创建输入 */
export interface McpProviderCreateInput {
  name: string;
  transport_type: McpTransportType;
  endpoint_url?: string | undefined;
  headers?: Record<string, string> | undefined;
  stdio_command?: string | undefined;
  stdio_args?: string[] | undefined;
  stdio_env?: Record<string, string> | undefined;
  api_keys?: string[] | undefined;
}

/** 更新输入 */
export interface McpProviderUpdateInput {
  name?: string | undefined;
  transport_type?: McpTransportType | undefined;
  endpoint_url?: string | undefined;
  headers?: Record<string, string> | undefined;
  stdio_command?: string | undefined;
  stdio_args?: string[] | undefined;
  stdio_env?: Record<string, string> | undefined;
  api_keys?: string[] | undefined;
  is_active?: boolean | undefined;
}
