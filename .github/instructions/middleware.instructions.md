---
description: '中间件规范 — Middleware 类型、applyMiddlewares 执行链、编写模板'
applyTo: 'src/middleware/**/*.ts, src/server.ts'
---

# 中间件规范

中间件通过修改 `ModelHttpContext` 传递数据，不直接操作 Express `Request/Response`。

---

## 1. 中间件类型签名

```typescript
// src/middleware/types.ts
import type { ModelHttpContext } from '@/types';

export type Middleware = (ctx: ModelHttpContext) => void | Promise<void>;
```

## 2. `applyMiddlewares(ctx, middlewares[])` — 顺序执行

```typescript
import { applyMiddlewares } from '@/middleware';

await applyMiddlewares(ctx, [
  apiKeyAuth,                       // 1. 提取并验证 API Key
  rateLimit,                        // 2. 频率限制
  allowedModelCheck,                // 3. 检查模型可用性
  normalizeChatToolCallIds,         // 4. 规范化 Tool Call ID
  // ... 路由解析 ...
  tokenAccounting,                  // 5. 计费核算
  normalizeResponseChatToolCallIds, // 6. 响应 Tool Call ID 映射
]);
```

每个中间件依次对 `ctx` 读写，上一个的修改对下一个可见。**顺序约束**：`apiKeyAuth` 必须最先；`tokenAccounting` 必须在响应完成后。

## 3. 现有中间件清单

| 中间件                             | 文件位置                                | 功能                                   |
| ---------------------------------- | --------------------------------------- | -------------------------------------- |
| `apiKeyAuth`                       | `src/middleware/common/api-key-auth.ts` | 验证 API Key，写入 `ctx.appId/appName` |
| `rateLimit`                        | `src/middleware/model/http/request/`    | 基于内存的请求频率限制                 |
| `allowedModelCheck`                | `src/middleware/model/http/request/`    | 验证请求模型的能力支持                 |
| `normalizeChatToolCallIds`         | `src/middleware/model/http/request/`    | 统一化入站 Tool Call ID 格式           |
| `tokenAccounting`                  | `src/middleware/model/http/response/`   | Token 用量核算与计费                   |
| `normalizeResponseChatToolCallIds` | `src/middleware/model/http/response/`   | 统一化出站 Tool Call ID 格式           |

## 4. 编写新中间件的标准模板

```typescript
import type { ModelHttpContext } from '@/types';
import { createLogger, GatewayError, logColors } from '@/utils';

const logger = createLogger('Middleware:YourMiddleware', logColors.bold + logColors.gray);

/**
 * 描述功能、副作用、修改的 ctx 字段
 */
export async function yourMiddleware(ctx: ModelHttpContext): Promise<void> {
  // 1. 前置检查 → 失败抛 GatewayError（不吞掉）
  if (!ctx.someRequiredField) {
    throw new GatewayError(400, 'bad_request', 'Required field is missing');
  }
  // 2. 执行业务逻辑（可能异步）
  const result = await someAsyncOperation(ctx.someRequiredField);
  // 3. 写入 ctx 传递数据
  ctx.computedField = result;
}
```

**关键约束**：
- 只修改 `ctx`，不操作 Express `res`
- 错误通过 `throw GatewayError` 向上传递，**禁止** try-catch 吞掉
- 中间件间通过 `ctx` 字段传递数据，不用 `res.locals`
