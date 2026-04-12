// src/db/mcp-virtual-servers/types.ts — 虚拟 MCP 类型定义

/** 工具过滤模式 */
export type McpToolFilterMode = 'allow' | 'deny' | 'all';

/** 数据库行类型 */
export interface McpVirtualServerRow {
  [key: string]: unknown;
  id: string;
  name: string;
  description: string;
  mcp_provider_id: string;
  tool_filter_mode: McpToolFilterMode;
  tool_filter_list: string[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/** 创建输入 */
export interface McpVirtualServerCreateInput {
  name: string;
  description?: string | undefined;
  mcp_provider_id: string;
  tool_filter_mode?: McpToolFilterMode | undefined;
  tool_filter_list?: string[] | undefined;
}

/** 更新输入 */
export interface McpVirtualServerUpdateInput {
  name?: string | undefined;
  description?: string | undefined;
  mcp_provider_id?: string | undefined;
  tool_filter_mode?: McpToolFilterMode | undefined;
  tool_filter_list?: string[] | undefined;
  is_active?: boolean | undefined;
}
