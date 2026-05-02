// src/db/mcp-providers/types.ts — 提供商 MCP 类型定义
// 字段设计与 model_providers 保持对称

/** 传输类型（对应 mcp_providers.kind） */
export type McpTransportType = 'stdio' | 'sse' | 'streamable_http';

/**
 * MCP 提供商配置（存储于 config JSONB 字段中）
 * 包含传输层专属的配置参数
 */
export interface McpProviderConfig {
  /** HTTP 请求头（SSE / Streamable HTTP 使用） */
  headers?: Record<string, string> | undefined;
  /** 子进程命令（Stdio 传输使用） */
  stdio_command?: string | undefined;
  /** 子进程参数（Stdio 传输使用） */
  stdio_args?: string[] | undefined;
  /** 子进程环境变量（Stdio 传输使用） */
  stdio_env?: Record<string, string> | undefined;
}

/** 数据库行类型（与 model_providers 字段结构对称） */
export interface McpProviderRow {
  [key: string]: unknown;
  id: string;
  name: string;
  /** 传输类型，对称 model_providers.kind */
  kind: McpTransportType;
  /** 网络端点，对称 model_providers.base_url */
  base_url: string;
  /** 认证类型，默认 'api_key' */
  credential_type: string;
  /** API Key 池（JSONB 数组），对称 model_providers.credential */
  credential: string[];
  /** 传输层配置（headers/stdio_* 等），对称 model_providers.config */
  config: McpProviderConfig;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/** 创建输入 */
export interface McpProviderCreateInput {
  name: string;
  kind: McpTransportType;
  base_url?: string | undefined;
  credential_type?: string | undefined;
  credential?: string[] | undefined;
  config?: McpProviderConfig | undefined;
  metadata?: Record<string, string> | undefined;
}

/** 更新输入 */
export interface McpProviderUpdateInput {
  name?: string | undefined;
  kind?: McpTransportType | undefined;
  base_url?: string | undefined;
  credential_type?: string | undefined;
  credential?: string[] | undefined;
  config?: McpProviderConfig | undefined;
  is_active?: boolean | undefined;
  metadata?: Record<string, string> | undefined;
}
