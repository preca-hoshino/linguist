// src/types/http/embedding/response.ts — 嵌入响应类型

/**
 * 稀疏向量元素
 *
 * 稀疏向量仅保留非零元素，每个元素记录维度索引和对应值。
 */
export interface SparseEmbeddingElement {
  /** 维度索引 */
  index: number;
  /** 该维度的非零值 */
  value: number;
}

/**
 * Token 使用统计详情（多模态输入时各类型的 token 分布）
 */
export interface EmbeddingUsageDetails {
  /** 文本内容的 token 数 */
  text_tokens?: number | undefined;
  /** 图像内容的 token 数 */
  image_tokens?: number | undefined;
  /** 视频内容的 token 数 */
  video_tokens?: number | undefined;
}

/**
 * Token 使用统计（嵌入）
 * 由 InternalEmbeddingResponse 使用。
 */
export interface EmbeddingUsage {
  /** 输入内容消耗的总 token 数 */
  prompt_tokens: number;
  /** 总 token 数（嵌入 API 通常等于 prompt_tokens） */
  total_tokens: number;
  /** Token 详细分类（多模态输入时可用） */
  prompt_tokens_details?: EmbeddingUsageDetails | undefined;
}

/**
 * 嵌入响应实体 (Embedding Response)
 *
 * 不含 id / model / created 字段，由 ModelHttpContext 统一管理。
 * 每次响应只包含单条向量结果，不返回批量列表。
 */
export interface InternalEmbeddingResponse {
  /** 对象类型，固定为 'embedding' */
  object: 'embedding';

  /**
   * 稠密向量表示
   * - encoding_format='float'：浮点数数组
   * - encoding_format='base64'：base64 编码字符串
   */
  embedding: number[] | string;

  /**
   * 稀疏向量表示（可选）
   * 仅当请求中 sparse_embedding='enabled' 时返回，用于混合检索场景。
   */
  sparse_embedding?: SparseEmbeddingElement[] | undefined;

  /** Token 消耗统计 */
  usage?: EmbeddingUsage | undefined;
}
