# src/middleware/common — 共享鉴权中间件

> 父模块：参见 [middleware/README.md](../README.md)

## 简介

存放跨模型/MCP 共享的中间件，当前实现了 API Key 鉴权逻辑，供模型 HTTP 请求链使用，同时 MCP 路由层（`src/api/http/mcp/`）也使用相同的 `validateApiKeyFromRequest` 辅助函数。

## 目录结构

```
common/
├── api-key-auth.ts    # apiKeyAuth 中间件：从 ModelHttpContext.apiKey 验证 App，写入 ctx.appId/appName
├── index.ts           # 导出 apiKeyAuth
└── __tests__/         # 单元测试
```

## apiKeyAuth 中间件

```typescript
export async function apiKeyAuth(ctx: ModelHttpContext): Promise<void>
```

执行逻辑：

1. 检查 `REQUIRE_API_KEY` 环境变量，若为 `false` 则跳过（开发/测试环境）
2. 从 `ctx.apiKey` 读取原始 Key（为空则返回 `401 unauthorized`）
3. 调用 `lookupAppByKey(rawKey)` 内存缓存查找对应 App
4. App 不存在或未激活则返回 `401 invalid_api_key`
5. 鉴权通过：将 `appInfo.id` / `appInfo.name` 写入 `ctx.appId` / `ctx.appName`

> 此中间件在**请求拦截链**的第一位执行，后续 `allowedModelCheck` 依赖 `ctx.appId`。

## 使用方式

```typescript
// src/middleware/index.ts 中统一导出
export { apiKeyAuth } from './common';

// src/model/http/app/process.ts 中注册为请求中间件：
const requestMiddlewares = [apiKeyAuth, allowedModelCheck, normalizeChatToolCallIds];
```
