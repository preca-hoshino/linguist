# New API 提供商适配器

[New API](https://github.com/QuantumNous/new-api) 是一个 OpenAI 兼容的 LLM 网关，支持多种模型的代理转发。

## 特性

- **Chat**：完全兼容 OpenAI `/v1/chat/completions` 格式
- **Embedding**：兼容 OpenAI `/v1/embeddings` 格式
- **推理内容回填**：支持 `reasoning_content_backfill` 配置，用于代理推理模型（如 DeepSeek R1）的多轮对话
- **Bearer 认证**：标准 `Authorization: Bearer <apiKey>` 认证方式

## 与 DeepSeek 的关系

New API 和 DeepSeek 都使用 OpenAI 兼容的 API 格式，因此共享相同的推理内容缓存机制。当 New API 代理 DeepSeek R1 等推理模型时，`reasoning_content_backfill` 配置可确保多轮对话中 `reasoning_content` 字段的正确回传。
