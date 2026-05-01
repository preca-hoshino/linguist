---
description: 'API 设计规范 — OpenAI/Anthropic/Gemini 格式适配、路由解析、流式处理'
applyTo: 'src/api/**/*.ts, src/model/**/*.ts, src/server.ts'
---

# API 设计规范

## 概述
本文件定义 Linguist Gateway 的多格式 API 支持架构：OpenAI 兼容、Anthropic Messages、Google Gemini 三种 API 格式的适配器模式，以及请求路由解析和故障转移策略。

---

## 核心规则

### 1. 三种 API 格式的适配器架构

```
用户请求 (OpenAI/Gemini/Anthropic 格式)
        │
        ▼
  ┌─────────────┐
  │  Auth 提取   │ ← auth-helper.ts: 从不同格式的 Header 提取 API Key
  └──────┬──────┘
         │ ctx.apiKey, ctx.userFormat
         ▼
  ┌─────────────┐
  │  请求解析    │ ← UserAdapter: 格式特定 JSON → InternalChatRequest
  └──────┬──────┘
         │ ctx.request (标准化)
         ▼
  ┌─────────────┐
  │  路由解析    │ ← routeModel(): 虚拟模型 → 提供商 + 故障转移策略
  └──────┬──────┘
         │ ctx.route
         ▼
  ┌─────────────┐
  │  Provider    │ ← ProviderAdapter: 发送至上游，接收响应
  │  Adapter     │
  └──────┬──────┘
         │ ctx.response (标准化)
         ▼
  ┌─────────────┐
  │  响应构建    │ ← UserResponseAdapter: InternalChatResponse → 格式特定 JSON
  └──────┬──────┘
         │
         ▼
      用户 (OpenAI/Gemini/Anthropic 格式)
```

### 2. 各格式的独立模块边界

每种格式提供 4 个模块：

| 模块           | 职责                                   | 文件位置示例                                        |
| -------------- | -------------------------------------- | --------------------------------------------------- |
| **Auth 提取**  | 从请求中提取 API Key                   | `src/api/http/auth-helper.ts`（共享）               |
| **请求解析**   | 用户格式 → 内部 `InternalChatRequest`  | `src/model/http/users/<format>/`                    |
| **响应构建**   | 内部 `InternalChatResponse` → 用户格式 | `src/model/http/users/<format>/`                    |
| **错误格式化** | GatewayError → 格式特定的错误 JSON     | `src/model/http/users/<format>/error-formatting.ts` |

**格式注册**（在 `src/model/http/users/index.ts` 启动时注册）：

```typescript
import {
  GeminiChatRequestAdapter,
  GeminiChatResponseAdapter,
  GeminiChatStreamResponseAdapter,
  GeminiEmbeddingRequestAdapter,
  GeminiEmbeddingResponseAdapter,
} from './gemini';

// 注册 Gemini 聊天适配器
registerChatAdapter('gemini', {
  request: new GeminiChatRequestAdapter(),
  response: new GeminiChatResponseAdapter(),
  stream: new GeminiChatStreamResponseAdapter(),
});

// 注册 Gemini Embedding 适配器
registerEmbeddingAdapter('gemini', {
  request: new GeminiEmbeddingRequestAdapter(),
  response: new GeminiEmbeddingResponseAdapter(),
});
```

### 3. 路由解析流程

虚拟模型 → 提供商 → 故障转移策略：

```typescript
// 简化示意
type RoutingResult = {
  model: string;           // 提供商侧模型 ID
  providerKind: string;    // 协议类型
  providerId: string;      // 提供商配置 UUID
  providerConfig: ProviderConfig; // 完整配置
  strategy: 'load_balance' | 'failover';
  capabilities: string[];
  timeoutMs?: number;
};
```

**路由策略**：
- `load_balance` — 从多个后端中负载均衡选择一个
- `failover` — 按优先级列表依次尝试，首个成功即返回

### 4. `handleError()` — 格式特定的错误响应

定义在 `src/model/http/users/error-handler.ts`：

```typescript
export function handleError(err: unknown, res: Response, format?: string): void {
  // 1. 日志记录：
  //    GatewayError → warn；未知错误 → error
  if (err instanceof GatewayError) {
    logger.warn({ errorCode: err.errorCode, statusCode: err.statusCode, format }, err.message);
  } else {
    logger.error({ err, format }, 'Unexpected error');
  }

  // 2. 构建格式特定的错误体并发送
  const { status, body } = buildErrorResponseBody(err, format);
  res.status(status).json(body);
}
```

每种格式注册自己的错误体构建器：
- `openaicompat` → `buildOpenAICompatErrorBody()` → `{ error: { code, message, type } }`
- `gemini` → `buildGeminiErrorBody()` → `{ error: { code, message, status } }`
- `anthropic` → `buildAnthropicErrorBody()` → `{ type: 'error', error: { type, message } }`

### 5. 流式响应（SSE）处理

流式响应需要特殊处理：
- 设置 `Content-Type: text/event-stream`
- 每个 chunk 以 `data: <json>\n\n` 格式发送
- 流结束后发送 `data: [DONE]\n\n`
- `handleError()` 不支持流式错误（流开始后无法发送 JSON 错误）

### 6. API 端点路径

| 格式          | 基础路径                   |
| ------------- | -------------------------- |
| OpenAI 兼容   | `/model/openai-compat/v1/` |
| Anthropic     | `/model/anthropic/v1/`     |
| Google Gemini | `/model/gemini/v1/`        |
| MCP 网关      | `/mcp/`                    |

### 7. Route 404 处理

在 `src/server.ts` 中统一处理 404：

```typescript
app.use((req: Request, res: Response) => {
  // 根据路径前缀推断用户格式，返回对应格式的错误
  let format: string | undefined;
  if (req.path.startsWith('/model/gemini/')) format = 'gemini';
  else if (req.path.startsWith('/model/openai-compat/')) format = 'openaicompat';
  else if (req.path.startsWith('/model/anthropic/')) format = 'anthropic';
  handleError(new GatewayError(404, 'not_found', 'Not Found'), res, format);
});
```

---

## 常见陷阱

| 陷阱                                | 正确做法                                   |
| ----------------------------------- | ------------------------------------------ |
| 在适配器中直接操作 Express `res`    | 适配器只做数据转换，响应由 handler 层发送  |
| 新增 API 格式但忘记注册错误体构建器 | 调用 `registerErrorBodyBuilder()` 注册     |
| 流式请求中混用 `handleError()`      | 流式开始后只能关闭连接，无法发送 JSON 错误 |
| 路由解析返回后未检查 `ctx.route`    | 始终检查 `ctx.route` 是否为 defined        |

---

## 项目参考

- `src/model/http/users/index.ts` — 适配器注册中心（`registerChatAdapter` / `registerEmbeddingAdapter`）
- `src/model/http/users/error-handler.ts` — `handleError()` 和 `buildErrorResponseBody()`
- `src/model/http/router/` — 路由解析实现
- `src/api/http/openaicompat/index.ts` — OpenAI 兼容 API 端点定义
- `src/api/http/anthropic/index.ts` — Anthropic API 端点定义
- `src/api/http/gemini/index.ts` — Gemini API 端点定义
- `src/server.ts` — 路由挂载和 404 处理
