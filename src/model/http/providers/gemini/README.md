# src/model/http/providers/gemini — Google Gemini 适配器

> 父模块：参见 [providers/README.md](../README.md)

## 简介

将 Linguist 内部类型转换为 Google Gemini 原生 API 格式（`generateContent` / `embedContent`），支持 Chat 和 Embedding 两种能力，含完整的工具调用、流式响应和 Token 用量转换。

## 目录结构

```
gemini/
├── index.ts          # geminiPlugin: ProviderPlugin
├── error-mapping.ts  # mapGeminiError() — 错误映射
├── chat/
│   ├── client.ts     # GeminiChatClient（x-goog-api-key 认证）
│   ├── request/
│   │   ├── index.ts              # GeminiChatRequestAdapter
│   │   ├── config-builder.ts     # GenerationConfig 构建
│   │   ├── message-converter.ts  # OpenAI 消息 → Gemini contents 转换（含工具调用历史）
│   │   ├── tool-converter.ts     # FunctionDeclaration 格式转换
│   │   ├── types.ts              # 请求原始类型
│   │   └── __tests__/
│   └── response/
│       ├── index.ts              # GeminiChatResponseAdapter
│       ├── candidate-converter.ts# Candidate → InternalMessage 转换
│       ├── usage-converter.ts    # UsageMetadata → ChatUsage 转换
│       ├── stream.ts             # GeminiChatStreamResponseAdapter（SSE + 换行 JSON 解析）
│       ├── types.ts              # 响应原始类型
│       └── __tests__/
└── embedding/
    ├── client.ts     # GeminiEmbeddingClient
    ├── request/
    │   └── index.ts  # GeminiEmbeddingRequestAdapter（含 batchEmbedContents 格式）
    └── response/
        └── index.ts  # GeminiEmbeddingResponseAdapter
```

## 协议特点

- 请求认证：`x-goog-api-key` header
- Gemini API 端点格式：`v1beta/models/{model}:generateContent`
- 工具调用使用 `functionCall` / `functionResponse` 而非 OpenAI 的 `tool_calls`
- Token 计数字段使用 `usageMetadata.promptTokenCount` / `candidatesTokenCount`
