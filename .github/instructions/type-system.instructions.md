---
description: '类型系统规范 — 内部类型分层、上下文对象、判别联合、命名约定、字段增删流程'
applyTo: 'src/types/**/*.ts'
---

# 类型系统规范

`src/types/` 是全网关的"通用语言"，所有模块通过此处的类型通信，不直接依赖其他模块内部实现。

---

## 1. 分层原则

| 层级             | 位置              | 规则                                                               |
| ---------------- | ----------------- | ------------------------------------------------------------------ |
| **通用类型**     | `src/types/*.ts`  | 跨模块共享（≥2 个模块使用）                                        |
| **模块专属类型** | 模块内 `types.ts` | 仅该模块内部使用（如 `providers/types.ts`、`middleware/types.ts`） |

> 新增类型时先判断使用范围：仅一个模块用 → 放模块内 `types.ts`；跨模块 → 放 `src/types/`。

## 2. 核心类型族谱

```
ModelHttpContext（HTTP 全生命周期载体）
├── request?:  InternalChatRequest | InternalEmbeddingRequest
├── response?: InternalChatResponse | InternalEmbeddingResponse
├── route?:    { model, modelType, providerKind, providerConfig, ... }
├── audit:     { userRequest, providerRequest, providerResponse, userResponse }
├── timing:    { start, requestAdapted, ..., end }
└── billing?:  { calculatedCost, costBreakdown }

ProviderConfig（提供商配置）
├── credential: ProviderCredential（判别联合）
└── config: ProviderAdvancedConfig

VirtualModelConfig（虚拟模型）
└── backends: VirtualModelBackend[]
    └── provider: ProviderConfig
```

## 3. 三大上下文对象

| 上下文              | 文件             | 协议              | 生命周期          |
| ------------------- | ---------------- | ----------------- | ----------------- |
| `ModelHttpContext`  | `context.ts`     | HTTP              | 单次请求/响应     |
| `ModelWsContext`    | `session.ts`     | WebSocket         | 长连接（有状态）  |
| `McpGatewayContext` | `mcp-context.ts` | JSON-RPC over SSE | 单次 MCP 方法调用 |

三者结构对称（id / ip / audit / timing），但语义独立，**禁止互相引用或强制转换**。

## 4. 判别联合模式

项目中多处使用判别联合实现类型安全的多态：

| 类型                 | 判别字段 | 候选                                          |
| -------------------- | -------- | --------------------------------------------- |
| `ProviderCredential` | `type`   | `api_key` / `oauth2` / `copilot` / `none`     |
| `ContentPart`        | `type`   | `text` / `image` / `audio` / `video` / `file` |
| `EmbeddingInput`     | `type`   | `text` / `image` / `video`                    |
| `BillingResult`      | `status` | `success` / `skipped`                         |
| `ResponseFormat`     | `type`   | `text` / `json_object` / `json_schema`        |

> 新增多态类型时**必须**使用判别联合，禁止用可选字段 + 运行时 `if` 判断。

## 5. 字段命名与省略约定

| 约定                            | 说明                                                                        |
| ------------------------------- | --------------------------------------------------------------------------- |
| 内部类型用 `camelCase`          | `InternalChatRequest.messages`、`ProviderConfig.baseUrl`                    |
| API 响应用 `snake_case`         | `created_at`、`is_active`、`pricing_tiers`                                  |
| **`model` 不入内部请求**        | 模型名由 `ctx.requestModel`（虚拟模型）和 `ctx.route.model`（提供商侧）管理 |
| **`id`/`created` 不入内部响应** | 由用户适配器层从 `ctx.id` 和 `ctx.timing.start` 生成                        |
| `undefined` 表示"未设置"        | 可选字段用 `?: T \| undefined`，不用 `null`（除非数据库 NULL 语义）         |

## 6. 新增 / 重构 / 删除字段流程

### 新增

1. 在对应 `.ts` 文件添加字段
2. 新文件需在 `index.ts` 添加 `export type *`
3. `npm run check` → 编译器高亮所有需更新的调用位置 → 逐一修复

### 重构

- 改 `ModelHttpContext` → 影响 `app/`、`router/`、所有中间件、用户适配器、`db/request-logs`
- 改 `route` 子对象 → 同步更新 `router/index.ts`（赋值）、`providers/engine.ts`（读取）、`db/request-logs.ts`（快照）
- 改内部请求/响应 → 同步更新所有用户适配器（`users/`）和提供商适配器（`providers/`）

### 删除

1. 从 `.ts` 文件删除字段
2. `npm run check` → 清理所有引用
