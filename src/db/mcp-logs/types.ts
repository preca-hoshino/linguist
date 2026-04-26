// src/db/mcp-logs/types.ts — MCP 日志冷热双表类型定义

import type { McpGatewayContext } from '@/types';

// ==================== 窄热表类型（mcp_logs） ====================

/**
 * 列表专用日志条目（仅窄表字段，不含 JSONB，用于分页列表接口）
 * 直接使用 mcp_logs 窄表独立列，无需 JOIN mcp_log_details 宽表
 */
export interface McpLogListItem {
  id: string;
  virtual_mcp_id: string | null;
  mcp_provider_id: string | null;
  app_id: string | null;
  session_id: string;
  status: 'processing' | 'completed' | 'error';
  method: string;
  /** 工具名称（仅 tools/call 时填充，从 McpGatewayContext.toolName 提取） */
  tool_name: string | null;
  /** 错误摘要（冗余至窄表，便于列表过滤） */
  error_message: string | null;
  /** 全链路耗时（ms） */
  duration_ms: number | null;
  created_at: string;
  updated_at: string;
}

// ==================== 冷宽表类型（mcp_log_details） ====================

/**
 * 详情页完整日志条目（含 JSONB 宽表，仅用于单行按 ID 点查）
 * 查询时 LEFT JOIN mcp_log_details，通过 mcp_context 还原完整审计数据
 */
export interface McpLogEntry {
  id: string;
  virtual_mcp_id: string | null;
  mcp_provider_id: string | null;
  app_id: string | null;
  session_id: string;
  status: 'processing' | 'completed' | 'error';
  method: string;
  tool_name: string | null;
  error_message: string | null;
  duration_ms: number | null;
  created_at: string;
  updated_at: string;
  /** McpGatewayContext 完整快照（唯一审计数据源） */
  mcp_context: McpGatewayContext | null;
}

// ==================== 写入输入类型 ====================

/**
 * MCP 日志写入输入
 * 直接接受 McpGatewayContext，由写入函数负责字段提取与映射
 */
export type McpLogCreateInput = McpGatewayContext;

// ==================== 查询参数类型 ====================

/** MCP 日志列表查询参数 */
export interface McpLogQuery {
  virtual_mcp_id?: string | undefined;
  mcp_provider_id?: string | undefined;
  app_id?: string | undefined;
  status?: 'processing' | 'completed' | 'error' | undefined;
  method?: string | undefined;
  tool_name?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

// ==================== SQL 列常量 ====================

/** 列表查询列：仅查窄表（严禁 JOIN mcp_log_details） */
export const LIST_COLUMNS: string = `
  m.id, m.virtual_mcp_id, m.mcp_provider_id, m.app_id, m.session_id,
  m.status, m.method, m.tool_name, m.error_message, m.duration_ms,
  m.created_at, m.updated_at
`.trim();

/** 详情查询列：仅用于单行按 ID 点查（JOIN 冷表） */
export const ENTRY_COLUMNS: string = `
  m.id, m.virtual_mcp_id, m.mcp_provider_id, m.app_id, m.session_id,
  m.status, m.method, m.tool_name, m.error_message, m.duration_ms,
  m.created_at, m.updated_at, d.mcp_context
`.trim();
