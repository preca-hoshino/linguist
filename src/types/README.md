# src/types — 内部统一类型定义

> 项目总览：参见 [README.md](../README.md)
> 
> 依赖本模块的所有其他模块：app、api、admin、config、db、router、middleware、users、providers、utils

## 简介

定义网关内部各模块通信使用的所有 TypeScript 类型，是整个系统的"通用语言"。除 `types/` 外的所有模块均只依赖这里的类型，而不直接依赖其他模块的内部实现。

## 目录结构

```
types/
├── index.ts            # 顶层聚合 barrel（对外唯一入口，按层 re-export）
│
├── common/             # 跨协议通用类型（≥2 层共享，或无协议归属）
│   ├── api.ts          #   ApiErrorType、ApiErrorBody、ApiErrorResponse
│   ├── billing.ts      #   PricingTier、CostBreakdown、BillingResult
│   ├── config.ts       #   ModelType、ProviderCredential、ProviderConfig、VirtualModelConfig、ResolvedRoute
│   └── provider.ts     #   HttpHeaders、ProviderErrorDetail、ProviderCallResult、ProviderStreamResult
│
├── http/               # HTTP V1 协议层（无状态请求/响应）
│   ├── context.ts      #   ModelHttpContext、RoutedModelHttpContext
│   ├── chat/           #   聊天域（barrel 模式）
│   │   ├── shared.ts   #     ContentPart、InternalMessage、ToolCall、ToolDefinition、ThinkingConfig、ChatUsage
│   │   ├── request.ts  #     InternalChatRequest
│   │   ├── response.ts #     ChatChoice、InternalChatResponse
│   │   └── streaming.ts#     ToolCallDelta、ChatStreamDelta、InternalChatStreamChunk
│   └── embedding/      #   嵌入域（barrel 模式）
│       ├── input.ts    #     EmbeddingInput（判别联合）
│       ├── task-type.ts#     EmbeddingTaskType
│       ├── request.ts  #     InternalEmbeddingRequest
│       └── response.ts #     SparseEmbeddingElement、EmbeddingUsage、InternalEmbeddingResponse
│
├── ws/                 # WebSocket V2 协议层（有状态长连接）
│   ├── context.ts      #   ModelWsContext、WsSessionState、WsSessionEvent
│   └── realtime/       #   实时事件域（barrel 模式）
│       ├── client-events.ts  # WsSessionUpdate ~ WsResponseCancel（9 个客户端事件）
│       ├── server-events.ts  # WsSessionCreated ~ WsError（10 个服务端事件）
│       ├── conversation.ts   # WsContentPart、WsConversationItem
│       ├── unions.ts         # WsClientEvent、WsServerEvent（联合类型）
│       └── frame.ts          # InternalWSFrame
│
└── mcp/                # MCP 协议层（协议代理）
    ├── context.ts      #   McpGatewayContext、McpLogCreateInput
    └── protocol.ts     #   McpToolDefinition、McpCallRequest、McpContent、McpCallResponse
```

## 核心设计约定

1. **内部类型不含 `model` 字段**：`model` 由 `GatewayContext.requestModel`（虚拟模型 ID）和 `ctx.route.model`（提供商侧模型名）管理。
2. **内部响应不含 `id`/`created`**：这些字段在用户响应适配器中从 `ctx.id` 和 `ctx.timestamp` 生成。
3. **`GatewayContext` 字段分组**：
   - `http: { method, path, userAgent }` — HTTP 入站元数据
   - `route?: { model, modelType, providerKind, providerId, providerConfig, strategy, capabilities }` — 路由解析后的完整上下文（由路由模块一次性填充）
   - `audit: { userRequest, providerRequest, providerResponse, userResponse }` — 四次 HTTP 交换的头部 + 请求体/响应体（审计日志的唯一完整数据源，完整 `GatewayContext` 快照直接写入数据库 `gateway_context` JSONB 列）
   - `timing: { start, requestAdapted, ... , end }` — 各阶段毫秒时间戳
   - `providerError?: ProviderErrorDetail` — 提供商原始错误详情（HTTP 状态码、错误码、原始响应体），仅提供商来源的错误携带，用于审计和 UI 展示
4. **`RoutedGatewayContext`**：`GatewayContext` 的类型收窄版本，确保 `route` 字段非 undefined。使用 `assertRouted()` 类型守卫进行收窄。
5. **`ThinkingConfig` 百分比设计**：`InternalChatRequest.thinking` 内的 `budget_tokens` 由用户适配器层从级别描述按 `max_tokens` 百分比计算填入，提供商适配器层再按厂商 API 格式转换输出（详见下方"`ThinkingConfig` 整体流"）。
6. **路由策略联合类型**：`route.strategy` 字段支持 `'load_balance' | 'failover'` 两种值；`load_balance` 加权随机单次尝试不重试，`failover` 按优先级取第一个激活后端单次尝试不重试。

## `ThinkingConfig` 整体流

各层对思考参数的职责分界如下：

```
用户请求中的思考描述
  ├── OpenAI reasoning_effort ("minimal"/"low"/"medium"/"high")
  └── Gemini thinkingLevel ("MINIMAL"/"LOW"/"MEDIUM"/"HIGH")
          ↓ 用户适配器层：
            minimal/MINIMAL → ThinkingConfig { type: 'disabled' }
            其余级别按 max_tokens 百分比计算 budget_tokens
          ↓ 如直接提供数值（OpenAI thinking.budget_tokens 或 Gemini thinkingBudget）→ 直接使用
          ↓ OpenAI thinking.type → 直接映射 type 字段

ThinkingConfig { type: 'enabled' | 'disabled' | 'auto'; budget_tokens?: number }
          ↓ 提供商适配器层：针对性转换
  ├── DeepSeek → type ("enabled"/"disabled"，不支持 auto 视为 enabled）
  ├── 火山引擎 → type 直接透传（enabled/disabled/auto），reasoning_effort 作为独立顶层字段
  └── Gemini → type !== 'disabled' → includeThoughts:true，budget_tokens → thinkingBudget
```

**级别到 `budget_tokens` 的百分比映射（均基于请求的 max_tokens）：**

| 来源                      | 级别/值   | 百分比   |
| ------------------------- | --------- | -------- |
| OpenAI `reasoning_effort` | `minimal` | 关闭思考 |
| OpenAI `reasoning_effort` | `low`     | 20%      |
| OpenAI `reasoning_effort` | `medium`  | 50%      |
| OpenAI `reasoning_effort` | `high`    | 80%      |
| Gemini `thinkingLevel`    | `MINIMAL` | 关闭思考 |
| Gemini `thinkingLevel`    | `LOW`     | 20%      |
| Gemini `thinkingLevel`    | `MEDIUM`  | 50%      |
| Gemini `thinkingLevel`    | `HIGH`    | 80%      |

> `max_tokens`（或 `maxOutputTokens`）未指定时 `budget_tokens` 不被设置，交由提供商使用其默认思考预算。

## 新增 / 重构 / 删除向导

### 新增字段或类型

1. 确定新类型归属的协议层（`common/` / `http/` / `ws/` / `mcp/`）和域（`chat/` / `embedding/` / `realtime/` 等）
2. 将新字段添加到对应的 `.ts` 文件；如需新文件，在所在目录的 `index.ts` barrel 中添加 `export type *` 语句
3. 如是跨层通用类型，放入 `common/` 并确保在各层 barrel 均可达
4. TypeScript 编译器会高亮所有需要更新的调用位置，按错误人工更新

### 重构

- **更改 `ModelHttpContext` 字段**：影响 `http/context.ts`、`src/model/http/app/`、`src/model/http/router/`、所有中间件、用户响应适配器、`src/db/request-logs.ts`
- **更改 `route` 子对象**：需同步更新 `src/model/http/router/index.ts`（赋值）、`src/model/http/providers/engine.ts`（读取 + failover 重写）、`src/db/request-logs.ts`（快照）
- **更改内部请求/响应类型**：需更新所有用户适配器（`src/model/http/users/`）和提供商适配器（`src/model/http/providers/`）中的对应转换逻辑

### 删除字段

1. 从对应 `.ts` 文件中删除字段
2. 运行 `npm run check:types` 找出所有使用该字段的位置并一并清理
