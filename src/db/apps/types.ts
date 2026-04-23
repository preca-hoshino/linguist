// src/db/apps/types.ts — 应用（App）类型定义

/** 数据库行类型（内部使用） */
export interface AppRow {
  [key: string]: unknown;
  id: string;
  name: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  api_key: string;
  allowed_model_ids: string[];
}

/** API 创建输入 */
export interface AppCreateInput {
  name: string;
  allowed_model_ids?: string[] | undefined;
  allowed_mcp_ids?: string[] | undefined;
}

/** API 更新输入 */
export interface AppUpdateInput {
  name?: string | undefined;
  is_active?: boolean | undefined;
  allowed_model_ids?: string[] | undefined;
  allowed_mcp_ids?: string[] | undefined;
}
