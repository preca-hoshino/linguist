// src/users/gemini/embedding/request/types.ts — Gemini 嵌入请求类型定义

/**
 * Gemini embedContent 请求体
 *
 * POST /v1beta/models/{model}:embedContent
 */
export interface GeminiEmbedContentBody {
  content: {
    parts: { text: string }[];
  };
  taskType?: string;
  outputDimensionality?: number;
}
