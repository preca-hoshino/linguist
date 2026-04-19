# src/model/http/providers/copilot — GitHub Copilot 适配器

> 父模块：参见 [providers/README.md](../README.md)

## 简介

将 Linguist 内部类型转换为 GitHub Copilot API 格式（OpenAI 兼容），支持 Chat 和 Embedding 两种能力。Copilot 使用 OAuth 令牌认证机制，通过 `token-manager.ts` 动态获取和缓存 Bearer Token。

## 目录结构

```
copilot/
├── index.ts             # copilotPlugin: ProviderPlugin（注册入口）
├── error-mapping.ts     # mapCopilotError() — HTTP 状态码到 GatewayError 映射
├── token-manager.ts     # Copilot Token 动态获取与缓存（OAuth access_token → Bearer token 刷新）
├── constants.ts         # 端点 URL、固定请求头常量
├── chat/
│   ├── client.ts        # CopilotChatClient（通过 token-manager 动态获取 Bearer）
│   ├── index.ts
│   ├── request/         # CopilotChatRequestAdapter（内部类型 → Copilot Chat 格式）
│   │   └── index.ts
│   ├── response/        # CopilotChatResponseAdapter（Copilot 响应 → 内部类型）
│   │   ├── index.ts
│   │   └── stream.ts    # CopilotChatStreamResponseAdapter（流式响应 + fallback 机制）
│   └── fallback/        # Copilot 特有的备用路径逻辑
└── embedding/
    ├── client.ts        # CopilotEmbeddingClient
    ├── request/         # CopilotEmbeddingRequestAdapter
    │   └── index.ts
    └── response/        # CopilotEmbeddingResponseAdapter
        └── index.ts
```

## 注册

`copilotPlugin` 注册 `kind: 'copilot'`，由 `providers/index.ts` 统一注册。

## 认证特殊性

Copilot 使用 **OAuth 令牌**而非静态 API Key：`credential` 字段存储 `access_token`，`token-manager.ts` 负责将 `access_token` 兑换为短效 Bearer Token 并缓存，在过期前自动刷新。Chat Client 在每次请求前通过 `token-manager.getToken(config)` 获取最新 Bearer Token。
