---
description: '中间件规范 — 中间件类型、执行链、鉴权模式、编写模板'
applyTo: 'src/middleware/**/*.ts, src/server.ts'
---

# 中间件规范

## 概述
本文件定义 Linguist Gateway 的中间件体系：统一的 `Middleware` 类型、`applyMiddlewares()` 执行链、现有中间件清单，以及编写新中间件的标准模板。

---

## 核心规则

### 1. 中间件类型签名

中间件通过修改 `ModelHttpContext` 传递数据，不应直接操作 Express `Request/Response`：

```typescript
// src/middleware/types.ts
import type { ModelHttpContext } from '@/types';

/**
 * 统一中间件类型
 * - 同步中间件：直接返回 void
 * - 异步中间件：返回 Promise<void>
 */
export type Middleware = (ctx: ModelHttpContext) => void | Promise<void>;
```

### 2. `applyMiddlewares(ctx, middlewares[])` — 顺序执行

定义在 `src/middleware/index.ts`：

```typescript
import { applyMiddlewares } from '@/middleware';

// 顺序执行中间件链
await applyMiddlewares(ctx, [
  apiKeyAuth,           // 1. 提取并验证 API Key
  rateLimit,            // 2. 频率限制
  allowedModelCheck,    // 3. 检查模型可用性
  normalizeChatToolCallIds,  // 4. 规范化 Tool Call ID
  // ... 路由解析 ...
  tokenAccounting,      // 5. 计费核算
  normalizeResponseChatToolCallIds, // 6. 响应 Tool Call ID 映射
]);
```

每个中间件依次对 ctx 进行读写，上一个中间件的修改对下一个可见。

### 3. 现有中间件清单

| 中间件                             | 文件位置                                | 功能                                      |
| ---------------------------------- | --------------------------------------- | ----------------------------------------- |
| `apiKeyAuth`                       | `src/middleware/common/api-key-auth.ts` | 验证用户 API Key，写入 `appId`、`appName` |
| `rateLimit`                        | `src/middleware/model/http/request/`    | 基于内存的请求频率限制                    |
| `allowedModelCheck`                | `src/middleware/model/http/request/`    | 验证请求模型的能力支持                    |
| `normalizeChatToolCallIds`         | `src/middleware/model/http/request/`    | 统一化入站 Tool Call ID 格式              |
| `tokenAccounting`                  | `src/middleware/model/http/response/`   | Token 用量核算与计费                      |
| `normalizeResponseChatToolCallIds` | `src/middleware/model/http/response/`   | 统一化出站 Tool Call ID 格式              |

### 4. 编写新中间件的标准模板

```typescript
// src/middleware/<domain>/<name>.ts

import type { ModelHttpContext } from '@/types';
import { createLogger, GatewayError, logColors } from '@/utils';

const logger = createLogger('Middleware:YourMiddleware', logColors.bold + logColors.gray);

/**
 * 中间件描述：功能、副作用、修改的 ctx 字段
 *
 * @param ctx 请求上下文，中间件通过修改 ctx 传递数据
 */
export async function yourMiddleware(ctx: ModelHttpContext): Promise<void> {
  // 1. 前置检查
  if (!ctx.someRequiredField) {
    logger.warn({ requestId: ctx.id }, 'Missing required field');
    throw new GatewayError(400, 'bad_request', 'Required field is missing');
  }

  // 2. 执行业务逻辑（可能异步）
  const result = await someAsyncOperation(ctx.someRequiredField);
  logger.debug({ requestId: ctx.id, result }, 'Middleware processing done');

  // 3. 写入 ctx（传递数据给后续中间件）
  ctx.computedField = result;
}
```

### 5. Admin JWT 鉴权 vs 用户 API Key 鉴权

| 路由类型                       | 鉴权方式                  | 用户标识传递               | 中间件                        |
| ------------------------------ | ------------------------- | -------------------------- | ----------------------------- |
| **Admin API** (`/api/admin/*`) | JWT Bearer Token          | `res.locals.userId`        | `adminAuth`（Express 中间件） |
| **用户 API** (`/model/*`)      | API Key (Bearer / Header) | `ctx.appId`、`ctx.appName` | `apiKeyAuth`（网关中间件）    |

**Admin 鉴权模式**（Express 中间件风格）：
```typescript
// src/admin/auth.ts
export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const payload = verifyToken(token, process.env.JWT_SECRET!);
  if (!payload) {
    res.status(401).json({ error: { code: 'unauthorized' } });
    return;
  }
  res.locals.userId = payload.sub;
  next();
}
```

**用户 API 鉴权模式**（网关中间件风格）：
```typescript
// src/middleware/common/api-key-auth.ts
export async function apiKeyAuth(ctx: ModelHttpContext): Promise<void> {
  // 从 ctx.apiKey 读取 → 查库验证 → 写入 ctx.appId / ctx.appName
}
```

---

## 常见陷阱

| 陷阱                           | 正确做法                                                             |
| ------------------------------ | -------------------------------------------------------------------- |
| 在中间件内 try-catch 吞掉错误  | 抛出 `GatewayError`，由 endpoint handler 的 `handleError()` 统一处理 |
| 中间件操作 Express `res` 对象  | 只修改 `ctx`，响应由 handler 层发送                                  |
| 中间件顺序错误                 | `apiKeyAuth` 必须最先执行，`tokenAccounting` 必须在响应完成后        |
| 在中间件中做重 I/O 而不用异步  | 使用 `async (ctx) => Promise<void>`                                  |
| 中间件间通过 `res.locals` 传递 | 使用 `ctx` 字段传递数据                                              |

---

## 项目参考

- `src/middleware/types.ts` — `Middleware` 类型定义
- `src/middleware/index.ts` — `applyMiddlewares()` 和中间件导出
- `src/middleware/common/api-key-auth.ts` — 异步中间件的标准范例
- `src/admin/auth.ts` — Admin JWT 鉴权的 Express 中间件范例
- `src/server.ts` — 路由挂载和中间件使用位置
