// src/db/api-keys/types.ts — API Key 类型定义

/** API Key 列表项（明文存储，key_value 始终可查看） */
export interface ApiKeySummary {
  [key: string]: unknown;
  id: string;
  app_id: string;
  name: string;
  key_value: string; // 完整明文 API Key (lk-xxx)，随时可查看
  key_prefix: string;
  is_active: boolean;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

// ApiKeyCreateResult 不再需要：key_value 始终包含在 ApiKeySummary 中
