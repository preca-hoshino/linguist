// src/types/http/embedding/request.ts — 嵌入请求类型

import type { EmbeddingInput } from './input';
import type { EmbeddingTaskType } from './task-type';

/**
 * 嵌入请求实体 (Embedding Request)
 *
 * 注意：不包含 model 字段。模型信息由 ModelHttpContext 管理。
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
