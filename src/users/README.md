# src/users — 用户格式适配器

> 项目总览：参见 [README.md](../README.md)
> 
> 相关模块：[`src/api/README.md`](../api/README.md)（API 路由）、[`src/types/README.md`](../types/README.md)（内部类型）

## 简介

将客户端发送的外部格式请求（当前支持 OpenAI 格式、Gemini 原生格式和 Anthropic 原生格式）转换为内部类型，并将内部响应转换回外部格式。实现格式多样性与主流程的解耦——新增用户格式不需修改核心流程。

## 目录结构

```
users/
├── index.ts                        # 注册中心：getUserChatAdapter / getUserEmbeddingAdapter
├── types.ts                        # 用户适配层基础接口定义
├── openaicompat/                   # OpenAI 兼容格式（格式标识：openaicompat）
│   ├── index.ts
│   ├── error-formatting.ts         # OpenAI 格式错误响应
│   ├── chat/                       # OpenAI Chat 适配器
│   │   ├── index.ts
│   │   ├── request/                # 请求转换逻辑
│   │   └── response/               # 响应转换逻辑
│   └── embedding/                  # OpenAI Embedding 适配器
├── gemini/                         # Gemini 原生格式（格式标识：gemini）
│   ├── index.ts
│   ├── error-formatting.ts         # Gemini 格式错误响应
│   ├── chat/                       # Gemini Chat 适配器
│   └── embedding/                  # Gemini Embedding 适配器
└── anthropic/                      # Anthropic 原生格式（格式标识：anthropic）
    ├── index.ts
    ├── error-formatting.ts         # Anthropic 格式错误响应
    └── chat/                       # Anthropic Chat 适配器
```

> **嵌入接口限制**：嵌入 API 每次请求仅处理**单条输入**，不支持批量（数组）输入。OpenAI 格式的 `input` 字段必须为 `string`（传入数组将返回 400 `batch_not_supported`）。

## 接口约定

```typescript
interface UserChatRequestAdapter {
  toInternal(body: unknown): InternalChatRequest;
}

interface UserChatResponseAdapter {
  fromInternal(ctx: GatewayContext): Record<string, unknown>;
}
```

**重要**：`toInternal` 不从请求体提取 `model` 字段（`model` 已在调用方存入 `ctx.requestModel`）。`fromInternal` 接收完整的 `GatewayContext`，从中读取 `ctx.id`、`ctx.timestamp`、`ctx.requestModel`、`ctx.response` 组装最终响应。

## 思考参数处理

用户适配器层负责将各外部格式的思考参数统一转换为 `ThinkingConfig { enabled, budget_tokens }`：

| 格式       | 输入参数                                                        | 处理逻辑                                                                             |
| ---------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **OpenAI** | `reasoning_effort: "minimal"∕"low"∕"medium"∕"high"`             | `minimal` → `type: 'disabled'`；其余按 `max_tokens` 百分比计算：20% / 50% / 80%      |
| **OpenAI** | `thinking: { type, budget_tokens }`                             | 直接使用（优先级高于 reasoning_effort）                                              |
| **Gemini** | `thinkingConfig.thinkingLevel: "MINIMAL"∕"LOW"∕"MEDIUM"∕"HIGH"` | `MINIMAL` → `type: 'disabled'`；其余按 `maxOutputTokens` 百分比计算：20% / 50% / 80% |
| **Gemini** | `thinkingConfig.thinkingBudget: number`                         | 直接使用（优先级高于 thinkingLevel）                                                 |
| **Gemini** | `thinkingConfig.includeThoughts: bool`                          | 映射为 `type`：`true` → `'enabled'`，`false` → `'disabled'`                          |

`max_tokens`（或 `maxOutputTokens`）未指定时，`budget_tokens` 不被设置，交由提供商使用其默认思考预算。

## 使用方式

```typescript
import { getUserChatAdapter } from '../users';

const userAdapter = getUserChatAdapter('openaicompat');
ctx.request = userAdapter.request.toInternal(requestBody);
// ... 处理 ...
const userRes = userAdapter.response.fromInternal(ctx);
```

## 新增 / 重构 / 删除向导

### 新增用户格式适配器

1. 在 `src/users/<format>/` 下新建目录
2. 实现：
   - `chat/request/index.ts` — `toInternal(body)` 方法
   - `chat/response/index.ts` — `fromInternal(ctx)` 方法
   - `error-formatting.ts` — 错误响应格式化
   - `chat/index.ts` — 按 `UserChatAdapter` 接口导出 `{ request, response, streamResponse }`
3. 在 `src/users/index.ts` 中注册新适配器
4. 在 `src/api/` 下创建对应的 HTTP 路由模块——参见 [`src/api/README.md`](../api/README.md)

### 重构

- **更改请求转换逻辑**：只修改 `<format>/chat/request/index.ts` 及其辅助文件，不影响其他格式
- **更改响应格式**：只修改 `<format>/chat/response/index.ts`；如需新字段，先在 `src/types/` 中扩展内部类型
- **重命名格式标识（format）**：同时修改 `<format>/index.ts` 中的注册键和 `src/api/` 中的 `userFormat` 参数

### 删除用户格式适配器

1. 删除 `src/users/<format>/` 目录
2. 在 `src/users/index.ts` 中移除注册
3. 删除 `src/api/<format>/` 中的 HTTP 路由模块，并在 `src/api/index.ts` 中移除注册——参见 [`src/api/README.md`](../api/README.md)
