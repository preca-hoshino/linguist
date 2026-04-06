// src/providers/embedding/volcengine/request/index.ts — 火山引擎嵌入请求适配器

import type { ProviderEmbeddingRequestAdapter } from '@/providers/types';
import type { EmbeddingInput, EmbeddingTaskType, InternalEmbeddingRequest } from '@/types';
import { createLogger, logColors } from '@/utils';

const logger = createLogger('Provider:VolcEngine:Embedding', logColors.bold + logColors.magenta);

/**
 * 内部任务类型 → 火山引擎 instructions 字段映射
 *
 * 依据火山引擎官方文档（doubao-embedding-vision-251215 及后续版本）的 instructions 配置规范：
 *
 * 任务分两大类：
 *  1. 召回/排序类：Query 侧与 Corpus（文档）侧分别使用不同指令
 *  2. 聚类/分类/STS 类：所有数据使用完全相同的指令
 *
 * 注意：
 *  - 模板固定部分（`Target_modality:`、`Instruction:`、`\nQuery:`）禁止修改，仅填充占位内容
 *  - 此处针对纯文本场景配置，多模态混合场景需在业务层自行覆盖
 */
const TASK_INSTRUCTIONS: Record<EmbeddingTaskType, string> = {
  // ── 召回/排序类 ────────────────────────────────────────────────────
  // Query 侧：生成用于检索相关文章的查询句向量
  RETRIEVAL_QUERY: 'Target_modality: text.\nInstruction:为这个句子生成表示以用于检索相关文章\nQuery:',
  // Corpus（文档）侧：将文档压缩为单词级稠密表示
  RETRIEVAL_DOCUMENT: 'Instruction:Compress the text into one word.\nQuery:',
  // 问答类 Query 侧：在知识库中找到能回答问题的候选文本
  QUESTION_ANSWERING: 'Target_modality: text.\nInstruction:根据这个问题，找到能回答这个问题的相应文本\nQuery:',
  // 代码检索 Query 侧：生成自然语言查询的向量以检索相关代码
  CODE_RETRIEVAL_QUERY: 'Target_modality: text.\nInstruction:为代码检索查询生成表示以用于检索相关代码\nQuery:',

  // ── 聚类/分类/STS 类（Query 与 Corpus 使用相同指令）─────────────────
  // STS 语义相似度：检索语义相近的文本
  SEMANTIC_SIMILARITY: 'Target_modality: text.\nInstruction:Retrieve semantically similar text\nQuery:',
  // 文本分类：按类别对文本进行分类
  CLASSIFICATION: 'Target_modality: text.\nInstruction:Classify text by category\nQuery:',
  // 文本聚类：按主题对文本进行聚类
  CLUSTERING: 'Target_modality: text.\nInstruction:Cluster these texts by topic\nQuery:',
  // 事实核查：检索语义相近的陈述以核实事实
  FACT_VERIFICATION:
    'Target_modality: text.\nInstruction:Retrieve semantically similar text for fact verification\nQuery:',
};

/**
 * 检查模型是否支持 instructions 字段
 *
 * 仅 doubao-embedding-vision-251215 及后续版本支持 instructions 字段。
 * 通过提取模型名称中的 6 位日期数字（YYMMDD）进行版本比较。
 */
function supportsInstructions(model: string): boolean {
  const version = /doubao-embedding-vision-(\d{6})/.exec(model)?.[1];
  if (version === undefined) {
    return false;
  }
  return Number.parseInt(version, 10) >= 251_215;
}

/**
 * 火山引擎多模态嵌入请求适配器
 * InternalEmbeddingRequest + routedModel → 火山引擎 /embeddings/multimodal 请求体
 *
 * 转换规则：
 * - 内部 EmbeddingTextInput { type:'text', text } → { type:'text', text }（直接映射）
 * - 内部 EmbeddingImageInput { type:'image', url?, base64_data? } → { type:'image_url', image_url: { url } }
 * - 内部 EmbeddingVideoInput { type:'video', url?, base64_data? } → { type:'video_url', video_url: { url } }
 * - sparse_embedding: 内部 'enabled'/'disabled' → { type: 'enabled'/'disabled' }
 * - task: 翻译为 instructions 字段（仅 doubao-embedding-vision-251215 及后续版本）
 */
export class VolcEngineEmbeddingRequestAdapter implements ProviderEmbeddingRequestAdapter {
  public toProviderRequest(internalReq: InternalEmbeddingRequest, routedModel: string): Record<string, unknown> {
    const instructionsSupported = supportsInstructions(routedModel);

    logger.debug(
      {
        routedModel,
        encodingFormat: internalReq.encoding_format,
        dimensions: internalReq.dimensions,
        sparseEmbedding: internalReq.sparse_embedding,
        task: internalReq.task,
        instructionsSupported,
      },
      'Adapting internal embedding request to VolcEngine format',
    );

    const input = internalReq.input.map((item) => this.convertInput(item));

    const req: Record<string, unknown> = {
      model: routedModel,
      input,
    };

    // instructions 字段：将内部 task 翻译为火山引擎指令（仅支持版本）
    if (internalReq.task !== undefined && instructionsSupported) {
      req.instructions = TASK_INSTRUCTIONS[internalReq.task];
      logger.debug(
        { task: internalReq.task, instructions: req.instructions },
        'Mapped task to VolcEngine instructions',
      );
    }

    if (internalReq.encoding_format !== undefined) {
      req.encoding_format = internalReq.encoding_format;
    }
    if (internalReq.dimensions !== undefined) {
      req.dimensions = internalReq.dimensions;
    }
    if (internalReq.sparse_embedding !== undefined) {
      req.sparse_embedding = {
        type: internalReq.sparse_embedding,
      };
    }

    return req;
  }

  /**
   * 将内部 EmbeddingInput 转为火山引擎格式
   */
  private convertInput(item: EmbeddingInput): Record<string, unknown> {
    switch (item.type) {
      case 'text': {
        return { type: 'text', text: item.text };
      }

      case 'image': {
        // base64_data 优先使用 data URI 格式，否则使用 url
        // 注意：内部类型未携带 MIME 类型，此处默认 image/jpeg
        const imageUrl =
          item.base64_data !== undefined && item.base64_data !== ''
            ? `data:image/jpeg;base64,${item.base64_data}`
            : item.url;
        return {
          type: 'image_url',
          image_url: { url: imageUrl },
        };
      }

      case 'video': {
        const videoUrl =
          item.base64_data !== undefined && item.base64_data !== ''
            ? `data:video/mp4;base64,${item.base64_data}`
            : item.url;
        return {
          type: 'video_url',
          video_url: { url: videoUrl },
        };
      }
    }
  }
}
