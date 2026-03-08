// src/db/api-keys/types.ts — API Key 类型定义

/** API Key 列表项（不含哈希） */
export interface ApiKeySummary {
  [key: string]: unknown;
  id: string;
  name: string;
  key_prefix: string;
  is_active: boolean;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

/** API Key 创建/轮换结果（包含明文 key，仅返回一次） */
export interface ApiKeyCreateResult extends ApiKeySummary {
  /** 明文 API Key（仅在创建/轮换时返回，之后无法再获取） */
  key: string;
}
