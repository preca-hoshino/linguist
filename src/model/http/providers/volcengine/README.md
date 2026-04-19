# src/model/http/providers/volcengine — 火山引擎适配器

> 父模块：参见 [providers/README.md](../README.md)

## 简介

将 Linguist 内部类型转换为火山引擎（Volcano Engine）大模型 API 格式（OpenAI 兼容超集），支持 Chat 和 Embedding 两种能力，包含图片生成和 TTS 的扩展类型定义。

## 目录结构

```
volcengine/
├── index.ts          # volcenginePlugin: ProviderPlugin
├── error-mapping.ts  # mapVolcengineError() — 错误映射
├── chat/
│   ├── client.ts     # VolcengineChatClient（Bearer Token，maas-api.res.volcengine.com 端点）
│   ├── request/
│   │   ├── index.ts              # VolcengineChatRequestAdapter
│   │   ├── message-converter.ts  # 消息格式转换（含工具调用）
│   │   ├── types.ts              # 火山引擎请求原始类型
│   │   └── __tests__/
│   └── response/
│       ├── index.ts   # VolcengineChatResponseAdapter
│       ├── stream.ts  # VolcengineChatStreamResponseAdapter
│       └── types.ts   # 火山引擎响应原始类型
└── embedding/
    ├── client.ts      # VolcengineEmbeddingClient
    ├── request/
    │   └── index.ts   # VolcengineEmbeddingRequestAdapter
    └── response/
        └── index.ts   # VolcengineEmbeddingResponseAdapter
```

## 协议特点

- 认证：`Authorization: Bearer <api_key>` header
- 与 OpenAI Chat Completions 格式高度兼容
- 端点 URL 通过 `provider.config.baseUrl` 配置（支持不同区域）
- 扩展类型定义支持图片生成（image/generations）和 TTS（audio/speech）接口，便于后续能力接入
