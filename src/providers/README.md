# src/providers — 提供商适配器

> 项目总览：参见 [README.md](../README.md)
> 
> 核心概念：[`src/types/README.md`](../types/README.md)（内部类型定义）、[`src/app/README.md`](../app/README.md)（调用方）

## 简介

将内部类型转换为各 AI 提供商的 API 格式（请求适配），将提供商响应转换回内部类型（响应适配），并封装 HTTP 通信（客户端）。每个提供商按 `request/`、`response/`、`client.ts` 三部分组织，复杂逻辑按功能拆分到独立文件。所有厂商特化逻辑均封装在适配器中，主流程仅依赖抽象接口。

## 目录结构

```
providers/
├── error-mapping/                 # 提供商错误映射（按厂商拆分）
│   ├── index.ts                   # mapProviderError 入口分派
│   ├── shared.ts                  # 共享工具（ProviderErrorInfo、fallbackByStatus、JSON 解析等）
│   ├── deepseek.ts                # DeepSeek 错误映射
│   ├── gemini.ts                  # Gemini 错误映射 + GEMINI_STATUS_MAP
│   └── volcengine.ts              # 火山引擎错误映射 + VOLCENGINE_CODE_PATTERNS
├── response-parser.ts         # 提供商 HTTP 响应解析：parseProviderResponse + fetchHeadersToRecord
├── caller.ts                  # 提供商调用与重试逻辑
├── chat/
│   ├── interface.ts           # ProviderChatRequestAdapter、ProviderChatResponseAdapter、ProviderChatClient 接口
│   ├── index.ts
│   ├── deepseek/              # DeepSeek 聊天适配器（已实现）
│   │   ├── index.ts
│   │   ├── client.ts          # HTTP 通信客户端
│   │   ├── request/
│   │   │   ├── index.ts       # DeepSeekChatRequestAdapter（编排层）
│   │   │   └── message-converter.ts  # reasoner 消息预处理
│   │   └── response/
│   │       ├── index.ts       # DeepSeekChatResponseAdapter（编排层）
│   │       └── types.ts       # DeepSeek 响应类型定义
│   ├── gemini/                # Google Gemini 聊天适配器（已实现）
│   │   ├── index.ts
│   │   ├── client.ts          # HTTP 通信客户端
│   │   ├── request/
│   │   │   ├── index.ts       # GeminiChatRequestAdapter（编排层）
│   │   │   ├── types.ts       # Gemini 请求类型定义
│   │   │   ├── message-converter.ts  # 消息格式转换（system/user/assistant/tool）
│   │   │   ├── tool-converter.ts     # 工具声明 & tool_choice 转换
│   │   │   └── config-builder.ts     # generationConfig & thinkingConfig 构建
│   │   └── response/
│   │       ├── index.ts       # GeminiChatResponseAdapter（编排层）
│   │       ├── types.ts       # Gemini 响应类型定义
│   │       ├── candidate-converter.ts  # candidate → choice 转换
│   │       └── usage-converter.ts      # usageMetadata → usage 转换
│   └── volcengine/            # 火山引擎聊天适配器
│       ├── index.ts
│       ├── client.ts
│       ├── request/
│       │   ├── index.ts       # VolcEngineChatRequestAdapter
│       │   └── message-converter.ts  # 多模态内容转换
│       └── response/
│           └── index.ts       # VolcEngineChatResponseAdapter
├── embedding/
│   ├── interface.ts
│   ├── index.ts
│   ├── gemini/                # Gemini 嵌入适配器
│   │   ├── index.ts
│   │   ├── client.ts
│   │   ├── request/
│   │   │   └── index.ts       # GeminiEmbeddingRequestAdapter
│   │   └── response/
│   │       └── index.ts       # GeminiEmbeddingResponseAdapter
│   └── volcengine/            # 火山引擎嵌入适配器
│       ├── index.ts
│       ├── client.ts
│       ├── request/
│       │   └── index.ts       # VolcEngineEmbeddingRequestAdapter
│       └── response/
│           └── index.ts       # VolcEngineEmbeddingResponseAdapter
└── index.ts                   # 注册中心（registerChatProvider / getProviderChatAdapterSet）
```

## 文件组织规范

每个提供商目录遵循以下结构：

- `index.ts` — 统一导出入口，简化外部引用路径
- `client.ts` — HTTP 通信客户端，封装厂商 API 调用
- `request/` — 请求适配层
  - `index.ts` — 适配器类（编排层），组合各转换器完成请求转换
  - `types.ts` — 厂商请求格式的类型定义
  - `message-converter.ts` — 消息格式转换逻辑
  - `tool-converter.ts` — 工具声明与选择策略转换
  - `config-builder.ts` — 生成配置构建（如 temperature、thinking 等）
- `response/` — 响应适配层
  - `index.ts` — 适配器类（编排层），组合各转换器完成响应转换
  - `types.ts` — 厂商响应格式的类型定义
  - `candidate-converter.ts` — 候选结果转换
  - `usage-converter.ts` — token 用量统计转换

> 并非所有提供商都需要全部文件，按实际复杂度拆分。简单提供商可只保留 `index.ts`。

## 接口约定

```typescript
// request/index.ts 实现
interface ProviderChatRequestAdapter {
  toProviderRequest(req: InternalChatRequest, model: string): unknown;
}
// response/index.ts 实现
interface ProviderChatResponseAdapter {
  fromProviderResponse(res: unknown): InternalChatResponse;
}
// client.ts 实现
interface ProviderChatClient {
  call(req: unknown, model: string): Promise<unknown>;
}
```

## 注册中心（工厂函数模式）

所有内置提供商在 `providers/index.ts` 中完成注册，适配器实例为模块级单例（无状态），仅 Client 在每次请求时按 `ProviderConfig` 实例化。

```typescript
// 聊天注册示例
registerChatProvider('deepseek', (config: ProviderConfig) => ({
  requestAdapter: deepseekRequestAdapter,   // 单例
  responseAdapter: deepseekResponseAdapter, // 单例
  client: new DeepSeekChatClient(config.apiKey, config.baseUrl),
}));

// 嵌入注册示例
registerEmbeddingProvider('gemini', (config: ProviderConfig) => ({
  requestAdapter: geminiEmbeddingRequestAdapter,   // 单例
  responseAdapter: geminiEmbeddingResponseAdapter, // 单例
  client: new GeminiEmbeddingClient(config.apiKey, config.baseUrl),
}));

// 获取（在 app/process.ts / caller.ts 中）
const { requestAdapter, responseAdapter, client } =
  getProviderChatAdapterSet(ctx.route.providerKind, ctx.route.providerConfig);
const { requestAdapter, responseAdapter, client } =
  getProviderEmbeddingAdapterSet(ctx.route.providerKind, ctx.route.providerConfig);

// 查询已注册的提供商 kind（用于管理 API 输入校验）
const validKinds: Set<string> = getRegisteredProviderKinds();
```

## 提供商调用与重试

`caller.ts` 负责调用提供商并处理失败重试。根据路由策略不同，`dispatchProvider` 和 `dispatchChatProviderStream` 的行为有所区别：

| 策略           | 行为                                                   |
| -------------- | ------------------------------------------------------ |
| `load_balance` | 调用单个加权随机后端；失败即返回错误，不重试           |
| `failover`     | 按 priority 取第一个激活的后端；失败即返回错误，不重试 |

所有 provider client 的 `fetch()` 调用均配置了 120 秒超时（`AbortSignal.timeout`）。

## 响应验证

每个提供商响应适配器在 `fromProviderResponse()` 中验证关键字段存在性（如 `choices` 数组、`data` 数组等），不合法时抛出 `GatewayError(502, 'provider_response_invalid')`。

## 错误映射

提供商返回的错误被 `mapProviderError(providerKind, httpStatus, body)`（`error-mapping/index.ts`）统一映射为网关错误码。各提供商的映射逻辑拆分到独立文件中：

| 文件                          | 提供商   | 解析方式                                        |
| ----------------------------- | -------- | ----------------------------------------------- |
| `error-mapping/deepseek.ts`   | DeepSeek | 按 HTTP 状态码映射（OpenAI 兼容格式）           |
| `error-mapping/volcengine.ts` | 火山引擎 | 解析 `error.code` 字段后按正则匹配              |
| `error-mapping/gemini.ts`     | Gemini   | 解析 `error.status` gRPC 状态字符串             |
| `error-mapping/shared.ts`     | （共享） | `ProviderErrorInfo` 类型、`fallbackByStatus` 等 |

`response-parser.ts` 中的 `parseProviderResponse()` 负责在提供商返回非 2xx 响应时调用 `mapProviderError` 解析错误并抛出 `GatewayError`。

`caller.ts` 在捕获提供商错误后，将 `GatewayError.providerDetail` 存入 `ctx.providerError` 用于审计，然后对错误消息进行脱敏（移除提供商名称和内部模型名）后重新抛出。

### 网关统一错误码表

| 错误码                     | HTTP | 含义                 |
| -------------------------- | ---- | -------------------- |
| `invalid_request`          | 400  | 请求格式不正确       |
| `invalid_parameter`        | 422  | 请求参数校验失败     |
| `missing_model`            | 400  | 缺少 model 标识      |
| `model_not_found`          | 404  | 模型不存在           |
| `model_type_mismatch`      | 400  | 模型类型不匹配       |
| `capability_not_supported` | 400  | 无满足能力要求的后端 |
| `no_backend_available`     | 503  | 所有后端不可用       |
| `unauthorized`             | 401  | 未提供 API Key       |
| `invalid_api_key`          | 401  | API Key 无效         |
| `authentication_error`     | 401  | 提供商认证失败       |
| `permission_denied`        | 403  | 权限不足             |
| `insufficient_balance`     | 402  | 余额不足             |
| `content_filtered`         | 400  | 内容安全策略拦截     |
| `rate_limit_exceeded`      | 429  | 速率/配额超限        |
| `quota_exceeded`           | 429  | 配额耗尽             |
| `provider_error`           | 502  | 提供商通用错误       |
| `provider_unavailable`     | 502  | 提供商服务不可用     |
| `provider_timeout`         | 504  | 提供商请求超时       |
| `route_error`              | 500  | 内部路由错误         |
| `internal_error`           | 500  | 网关内部错误         |
| `not_found`                | 404  | 资源不存在           |

## 已实现提供商

| 目录                    | 提供商        | kind         | 类型      |
| ----------------------- | ------------- | ------------ | --------- |
| `chat/deepseek/`        | DeepSeek      | `deepseek`   | Chat      |
| `chat/gemini/`          | Google Gemini | `gemini`     | Chat      |
| `chat/volcengine/`      | 火山引擎      | `volcengine` | Chat      |
| `embedding/gemini/`     | Google Gemini | `gemini`     | Embedding |
| `embedding/volcengine/` | 火山引擎      | `volcengine` | Embedding |

## 新增 / 重构 / 删除向导

### 新增提供商适配器

1. 在 `src/providers/chat/<provider>/`（或 `embedding/<provider>/`）下新建目录
2. 实现三个文件：
   - `request/index.ts` — 实现 `toProviderRequest(req, model)` 方法，将 `InternalChatRequest` 转为厂商请求格式
   - `response/index.ts` — 实现 `fromProviderResponse(res)` 方法，将厂商响应转回 `InternalChatResponse`
   - `client.ts` — 实现 `call(req, model)` 方法，封装 HTTP 通信，接收 `ProviderConfig`（apiKey、baseUrl）
   - `index.ts` — 导出三个适配器实例
3. 在 `src/providers/index.ts` 中使用 `registerChatProvider`（或 `registerEmbeddingProvider`）注册工厂函数：
   ```typescript
   registerChatProvider('myprovider', (config: ProviderConfig) => ({
     requestAdapter: myRequestAdapter,    // 单例
     responseAdapter: myResponseAdapter,  // 单例
     client: new MyProviderClient(config.apiKey, config.baseUrl),
   }));
   ```
4. 在管理 API 中创建提供商记录时使用对应的 `kind` 字段即可路由

### 重构

- **拆分复杂转换逻辑**：在对应的 `request/` 或 `response/` 目录下新建子文件（如 `message-converter.ts`、`tool-converter.ts`），并在编排层 `index.ts` 中调用
- **更改 Client 的 HTTP 层**：只修改 `client.ts`，请求/响应适配器不受影响
- **更新厂商 API 字段**：添加初始包含厂商请求格式类型定义的 `types.ts` 文件，尞寽适配器的转换逻辑

### 删除提供商

1. 删除 `src/providers/chat/<provider>/`（或 `embedding/<provider>/`）目录
2. 在 `src/providers/index.ts` 中移除对应的 `registerChatProvider`（或 `registerEmbeddingProvider`）调用
3. 确认数据库中无使用该 `kind` 的提供商和提供商模型记录（如有需通过管理 API 删除）
