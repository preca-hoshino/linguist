// src/types/http/embedding/input.ts — 嵌入输入类型

/**
 * 嵌入输入项 — 文本
 */
export interface EmbeddingTextInput {
  type: 'text';
  /** 要向量化的文本内容 */
  text: string;
}

/**
 * 嵌入输入项 — 图像
 *
 * 支持 URL 引用或 Base64 数据，二者至少提供其一。
 */
export interface EmbeddingImageInput {
  type: 'image';
  /** 图像的可访问 URL（支持 http/https 或 data URI） */
  url?: string | undefined;
  /** Base64 编码的图像数据 */
  base64_data?: string | undefined;
}

/**
 * 嵌入输入项 — 视频
 *
 * 支持 URL 引用或 Base64 数据，二者至少提供其一。
 */
export interface EmbeddingVideoInput {
  type: 'video';
  /** 视频的可访问 URL（支持 http/https 或 data URI） */
  url?: string | undefined;
  /** Base64 编码的视频数据 */
  base64_data?: string | undefined;
}

/** 嵌入输入项联合类型（支持文本、图像、视频的多模态输入） */
export type EmbeddingInput = EmbeddingTextInput | EmbeddingImageInput | EmbeddingVideoInput;
