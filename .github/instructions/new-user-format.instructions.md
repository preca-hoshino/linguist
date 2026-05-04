---
description: '新用户 API 格式接入指南 — UserChatAdapter 接口、API 端点、路由注册、错误格式'
applyTo: 'src/api/http/**/*.ts, src/model/http/users/**/*.ts'
---

# 新用户 API 格式接入指南

从零添加一种用户侧 API 格式（如 Mistral、Cohere 等）的完整步骤。以 `openaicompat/` 为最简模板，`gemini/` 为复杂模板。

---

## 前置条件

- 确认目标 API 格式规范（请求/响应结构、SSE 流格式、错误格式）
- 确认支持的模态：Chat / Embedding

---

## Step 1: 创建用户格式目录

```
src/model/http/users/<format>/
├── index.ts               # 导出所有适配器类
├── error-formatting.ts    # buildXxxErrorBody(err) → ErrorResponsePayload
├── chat/
│   ├── request/
│   │   └── index.ts       # 请求适配器（实现 UserChatRequestAdapter）
│   └── response/
│       ├── index.ts       # 响应适配器（实现 UserChatResponseAdapter）
│       └── stream.ts      # 流式响应适配器（实现 UserChatStreamResponseAdapter）
└── embedding/             # Embedding 适配器（如支持）
    ├── request/
    │   └── index.ts
    └── response/
        └── index.ts
```

## Step 2: 实现 Chat 适配器

### 2a. Request Adapter（`chat/request/index.ts`）

实现 `UserChatRequestAdapter` 接口：

```typescript
export class XxxChatRequestAdapter implements UserChatRequestAdapter {
  toInternal(userReq: unknown): InternalChatRequest {
    // 外部格式请求体 → InternalChatRequest
    // ⚠️ 不提取 model 字段（model 已在调用方存入 ctx.requestModel）
    // 处理 thinking 参数 → ThinkingConfig（参考 openaicompat 的 resolveThinking）
    // 校验参数范围，非法值抛 GatewayError(400, ...)
  }
}
```

### 2b. Response Adapter（`chat/response/index.ts`）

实现 `UserChatResponseAdapter` 接口：

```typescript
export class XxxChatResponseAdapter implements UserChatResponseAdapter {
  fromInternal(ctx: ModelHttpContext): Record<string, unknown> {
    // 从 ctx 中读取 response、id、requestModel、timing.start 组装响应
    // ⚠️ id/created/model 从 ctx 获取，不从 InternalChatResponse 获取
  }
}
```

### 2c. Stream Response Adapter（`chat/response/stream.ts`）

实现 `UserChatStreamResponseAdapter` 接口：

```typescript
export class XxxChatStreamResponseAdapter implements UserChatStreamResponseAdapter {
  formatChunk(ctx: ModelHttpContext, chunk: InternalChatStreamChunk): string {
    // InternalChatStreamChunk → 格式特定的 SSE 行（含 "data: " 前缀 + "\n\n" 后缀）
  }
  formatEnd(): string | null {
    // 流结束标记（如 "data: [DONE]\n\n"），无标记返回 null
  }
}
```

## Step 3: 实现错误格式化（`error-formatting.ts`）

```typescript
export function buildXxxErrorBody(err: unknown): ErrorResponsePayload {
  if (err instanceof GatewayError) {
    return { status: err.statusCode, body: { /* 格式特定错误结构 */ } };
  }
  return { status: 500, body: { /* 通用错误结构 */ } };
}
```

## Step 4: 注册适配器

在 `src/model/http/users/index.ts` 中：

```typescript
import { XxxChatRequestAdapter, XxxChatResponseAdapter, XxxChatStreamResponseAdapter } from './xxx';

registerChatAdapter('xxx', {
  request: new XxxChatRequestAdapter(),
  response: new XxxChatResponseAdapter(),
  streamResponse: new XxxChatStreamResponseAdapter(),
});
```

如支持 Embedding，还需调用 `registerEmbeddingAdapter('xxx', { ... })`。

## Step 5: 创建 API 端点（`src/api/http/<format>/index.ts`）

```typescript
import { Router } from 'express';
import { processChatCompletion, processEmbedding } from '@/model/http/app';
import { handleError } from '@/model/http/users';

const router = Router();

// API Key 提取函数（按目标格式的认证方式实现）
export function extractApiKey(req: Request): string | undefined { /* ... */ }

router.post('/v1/chat/completions', async (req, res) => {
  const model = (req.body as Record<string, unknown>).model as string ?? '';
  await processChatCompletion(req, res, 'xxx', model);
});

export { router as xxxRouter };
```

## Step 6: 注册路由与错误格式

在 `src/server.ts` 中：

1. 挂载路由：`app.use(xxxRouter);`
2. 在 404 处理中添加路径前缀判断：
   ```typescript
   } else if (req.path.startsWith('/model/xxx/')) {
     format = 'xxx';
   }
   ```

在 `src/model/http/users/error-handler.ts` 中注册错误构建器：

```typescript
import { buildXxxErrorBody } from './xxx/error-formatting';
registerErrorBodyBuilder('xxx', buildXxxErrorBody);
```

## Step 7: 更新日志缓存

在 `src/model/http/users/index.ts` 的 `getUserFormatLogger` 中添加：

```typescript
xxx: { label: 'User:Xxx', color: logColors.bold + logColors.xxx },
```

## Step 8: 编写单元测试

- 请求适配器：外部格式 → `InternalChatRequest` 的映射正确性（含参数校验）
- 响应适配器：`ModelHttpContext` → 外部格式 JSON 的映射正确性
- 流式适配器：chunk 格式化、结束标记
- 错误格式化：`GatewayError` / 未知异常 → 格式特定错误体
