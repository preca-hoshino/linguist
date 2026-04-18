// src/db/mcp-virtual-servers/types.ts — 虚拟 MCP 类型定义
// 与 virtual_models 命名对称

/**
 * 虚拟 MCP 配置（存储于 config JSONB 字段中）
 */
export interface VirtualMcpConfig {
  /** 启用的工具白名单（空数组表示全部开放） */
  tools?: string[] | undefined;
}

/** 数据库行类型 */
export interface VirtualMcpRow {
  [key: string]: unknown;
  id: string;
  name: string;
  description: string;
  mcp_provider_id: string;
  config: VirtualMcpConfig;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/** 创建输入 */
export interface VirtualMcpCreateInput {
  name: string;
  description?: string | undefined;
  mcp_provider_id: string;
  config?: VirtualMcpConfig | undefined;
}

/** 更新输入 */
export interface VirtualMcpUpdateInput {
  name?: string | undefined;
  description?: string | undefined;
  mcp_provider_id?: string | undefined;
  config?: VirtualMcpConfig | undefined;
  is_active?: boolean | undefined;
}
