// src/types/http/embedding/task-type.ts — 嵌入任务类型

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
