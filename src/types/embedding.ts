// src/types/embedding.ts — 嵌入相关类型定义

// ==================== 嵌入输入类型 ====================

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

// ==================== 嵌入任务类型 ====================

/**
 * 嵌入任务类型（参考 Gemini TaskType 枚举）
 *
 * 指定嵌入的使用场景，以优化向量质量。
 * 不支持此特性的提供商适配器可忽略。
 */
export type EmbeddingTaskType =
  | 'RETRIEVAL_QUERY' // 针对搜索查询优化
  | 'RETRIEVAL_DOCUMENT' // 针对被检索文档优化
  | 'SEMANTIC_SIMILARITY' // 评估文本相似度
  | 'CLASSIFICATION' // 文本分类
  | 'CLUSTERING' // 文本聚类
  | 'QUESTION_ANSWERING' // 问答系统中的问题
  | 'FACT_VERIFICATION' // 事实核查待验证陈述
  | 'CODE_RETRIEVAL_QUERY'; // 代码检索中的自然语言查询

// ==================== 嵌入请求 ====================

/**
 * 嵌入请求实体 (Embedding Request)
 *
 * 注意：不包含 model 字段。模型信息由 GatewayContext 管理。
 * 支持多模态内容数组输入（文本、图像、视频），所有输入项合并生成一个向量。
 *
 * 各用户端点输入映射（入站）：
 * - OpenAI（纯文本）：单条 string → `[EmbeddingTextInput]`
 * - Gemini（纯文本）：content.parts 文本数组 → `EmbeddingTextInput[]`
 * 以上两种端点仅产生 EmbeddingTextInput，不包含图像或视频。
 *
 * 各提供商输出映射（出站）：
 * - Gemini（纯文本）：仅消费 EmbeddingTextInput，非文本项将被丢弃并记录警告
 * - 火山引擎（多模态）：支持完整 EmbeddingInput[]（文本/图像/视频混合）
 */
export interface InternalEmbeddingRequest {
  /**
   * 要进行向量化的内容数组
   *
   * 所有输入项组合生成单个嵌入向量。
   * 支持文本（EmbeddingTextInput）、图像（EmbeddingImageInput）、视频（EmbeddingVideoInput）三种类型。
   *
   * 当前所有用户端点（OpenAI / Gemini）仅产生纯文本输入。
   * 多模态输入（图像/视频）仅由支持多模态的提供商（如火山引擎）消费。
   */
  input: EmbeddingInput[];

  /**
   * 返回向量的编码格式
   * - 'float': 返回浮点数数组（默认）
   * - 'base64': 返回 base64 编码的二进制数据
   */
  encoding_format?: 'float' | 'base64' | undefined;

  /**
   * 返回向量的目标维度
   *
   * 由模型决定支持哪些维度值。
   * 例如：火山引擎支持 1024 / 2048，Gemini 支持 128–3072。
   */
  dimensions?: number | undefined;

  /**
   * 稀疏向量配置
   * - 'enabled': 同时输出稠密向量和稀疏向量
   * - 'disabled': 仅输出稠密向量（默认）
   *
   * 稀疏向量用于混合搜索（结合稠密和稀疏向量的检索方法）。
   */
  sparse_embedding?: 'enabled' | 'disabled' | undefined;

  /**
   * 嵌入任务类型提示（Gemini 等模型支持）
   *
   * 指定嵌入的使用场景，以优化向量质量。
   * 不支持此特性的提供商适配器可忽略。
   */
  task?: EmbeddingTaskType | undefined;

  /** 终端用户标识（用于追踪和分析） */
  user?: string | undefined;
}

// ==================== 嵌入响应 ====================

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
 * 不含 id / model / created 字段，由 GatewayContext 统一管理。
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
