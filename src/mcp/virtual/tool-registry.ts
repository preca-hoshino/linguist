// src/mcp/virtual/tool-registry.ts — MCP 工具注册与权限控制

import type { McpToolFilterMode } from '@/db/mcp-virtual-servers/types';
import type { McpToolInfo } from '../providers/base-client';

/**
 * 检查单个工具是否允许调用
 * @param toolName 工具名称
 * @param mode 过滤模式 ('allow', 'deny', 'all')
 * @param filterList 过滤列表
 */
export function isToolAllowed(toolName: string, mode: McpToolFilterMode, filterList: string[]): boolean {
  if (mode === 'all') {
    return true;
  }
  if (mode === 'allow') {
    return filterList.includes(toolName);
  }
  return !filterList.includes(toolName);
}

/**
 * 根据 ACL 规则过滤工具列表
 * @param tools 原始工具列表
 * @param mode 过滤模式
 * @param filterList 过滤列表
 */
export function filterTools(tools: McpToolInfo[], mode: McpToolFilterMode, filterList: string[]): McpToolInfo[] {
  if (mode === 'all') {
    return tools;
  }
  return tools.filter((t) => isToolAllowed(t.name, mode, filterList));
}
