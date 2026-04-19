# src/model/http/providers/deepseek — DeepSeek 适配器

> 父模块：参见 [providers/README.md](../README.md)

## 简介

将 Linguist 内部类型转换为 DeepSeek API 格式（OpenAI 兼容超集），支持 Chat 能力（含工具调用）。

## 目录结构

```
deepseek/
├── index.ts          # deepseekPlugin: ProviderPlugin
├── error-mapping.ts  # mapDeepSeekError() — 错误映射
└── chat/
    ├── client.ts     # DeepSeekChatClient（标准 Bearer Token，chat.deepseek.com/v1/chat/completions）
    ├── request/
    │   ├── index.ts              # DeepSeekChatRequestAdapter
    │   ├── message-converter.ts  # 消息格式转换（含工具调用消息）
    │   └── __tests__/
    └── response/
        ├── index.ts     # DeepSeekChatResponseAdapter
        ├── stream.ts    # DeepSeekChatStreamResponseAdapter（SSE 流处理）
        └── types.ts     # DeepSeek 响应原始类型
```

## 注册

`deepseekPlugin` 注册 `kind: 'deepseek'`，仅支持 `getChatAdapterSet`，不支持 `getEmbeddingAdapterSet`。

## 协议特点

DeepSeek 与 OpenAI Chat Completions API 高度兼容，关键差异：
- 支持 `reasoning_content` 字段（DeepSeek-R1 系列思考过程文本）
- 工具调用格式与 OpenAI 一致，通过 `message-converter.ts` 处理
