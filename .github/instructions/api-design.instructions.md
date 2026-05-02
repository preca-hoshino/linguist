---
description: 'API 设计规范 — OpenAI/Anthropic/Gemini 格式适配、路由解析、流式处理'
applyTo: 'src/api/http/**/*.ts, src/model/http/**/*.ts, src/server.ts'
---

# API 设计规范

多格式 API 适配架构：OpenAI 兼容 / Anthropic Messages / Google Gemini 三种格式，统一适配器模式。

---

## 1. 适配器架构

```
用户请求 (OpenAI / Gemini / Anthropic 格式)
  → Auth 提取 (auth-helper.ts) → ctx.apiKey, ctx.userFormat
  → 请求解析 (UserAdapter) → InternalChatRequest
  → 路由解析 (routeModel) → ctx.route (provider + 故障转移策略)
  → Provider Adapter → 发送上游，接收响应
  → 响应构建 (UserResponseAdapter) → 格式特定 JSON
  → 错误处理 (handleError → [error-handling 规范](./error-handling.instructions.md))
```

## 2. 各格式的独立模块边界

每种格式提供 4 个模块（位于 `src/model/http/users/<format>/`）：

| 模块           | 职责                                   |
| -------------- | -------------------------------------- |
| **请求解析**   | 用户格式 → `InternalChatRequest`       |
| **响应构建**   | `InternalChatResponse` → 用户格式 JSON |
| **流式响应**   | SSE chunk 逐块转换                     |
| **错误格式化** | GatewayError → 格式特定错误 JSON       |

格式注册（`src/model/http/users/index.ts`）：

```typescript
registerChatAdapter('gemini', {
  request: new GeminiChatRequestAdapter(),
  response: new GeminiChatResponseAdapter(),
  stream: new GeminiChatStreamResponseAdapter(),
});
```

## 3. 路由解析

虚拟模型 → 提供商 + 故障转移策略：

| 策略           | 行为                             |
| -------------- | -------------------------------- |
| `load_balance` | 从多个后端负载均衡选一个         |
| `failover`     | 按优先级依次尝试，首个成功即返回 |

始终检查 `ctx.route` 是否为 defined。

## 4. 流式响应（SSE）

- `Content-Type: text/event-stream`
- 每个 chunk：`data: <json>\n\n`
- 流结束：`data: [DONE]\n\n`
- **流开始后不能用 `handleError()`** — 只能关闭连接

## 5. API 端点路径

| 格式        | 基础路径                   |
| ----------- | -------------------------- |
| OpenAI 兼容 | `/model/openai-compat/v1/` |
| Anthropic   | `/model/anthropic/v1/`     |
| Gemini      | `/model/gemini/v1/`        |
| MCP 网关    | `/mcp/`                    |

## 6. Route 404 处理

在 `src/server.ts` 中按路径前缀推断格式返回对应错误格式的 404。新增格式时**必须**注册 `registerErrorBodyBuilder()`。
