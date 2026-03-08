// src/users/embedding/openaicompat/request/types.ts — OpenAI 兼容嵌入请求类型定义

/**
 * OpenAI 兼容嵌入请求体类型
 *
 * OpenAI /v1/embeddings 格式：
 * - input: string | string[] — 要嵌入的文本
 * - encoding_format?: 'float' | 'base64'
 * - dimensions?: number
 * - user?: string
 */
export interface OpenAICompatEmbeddingRequestBody {
  /** 要向量化的文本内容（单条字符串，不支持数组批量输入） */
  input: string;
  encoding_format?: 'float' | 'base64';
  dimensions?: number;
  user?: string;
}
