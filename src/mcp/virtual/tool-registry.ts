// src/mcp/virtual/tool-registry.ts — MCP 工具注册与权限控制

import type { McpToolInfo } from '../providers/base-client';

/**
 * 检查单个工具是否允许调用
 * @param toolName 工具名称
 * @param allowedTools 过滤列表（白名单）
 */
export function isToolAllowed(toolName: string, allowedTools: string[]): boolean {
  return allowedTools.includes(toolName);
}

/**
 * 根据白名单过滤工具列表
 * @param tools 原始工具列表
 * @param allowedTools 过滤列表
 */
export function filterTools(tools: McpToolInfo[], allowedTools: string[]): McpToolInfo[] {
  return tools.filter((t) => isToolAllowed(t.name, allowedTools));
}
