// src/db/apps/types.ts — 应用（App）类型定义

/** 数据库行类型（内部使用，auth_mode 仅数据库层可见，不暴露于 API 响应） */
export interface AppRow {
  [key: string]: unknown;
  id: string;
  name: string;
  auth_mode: string; // 数据库预留，当前固定 'api_key'，不对外暴露
  is_active: boolean;
  created_at: string;
  updated_at: string;
  api_key: string;
  allowed_model_ids: string[];
}

/** API 创建输入（不含 auth_mode） */
export interface AppCreateInput {
  name: string;
  allowed_model_ids?: string[] | undefined;
}

/** API 更新输入（不含 auth_mode） */
export interface AppUpdateInput {
  name?: string | undefined;
  is_active?: boolean | undefined;
  allowed_model_ids?: string[] | undefined;
}
