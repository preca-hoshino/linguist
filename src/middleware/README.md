# src/middleware — 中间件模块

> 项目总览：参见 [README.md](../README.md)
> 
> 相关模块：[`src/app/README.md`](../app/README.md)（执行位置）、[`src/users/README.md`](../users/README.md)（格式无关）

## 简介

定义中间件类型，提供顺序执行中间件链的执行器。中间件是在请求处理各阶段插入横切逻辑（鉴权、限流、日志等）的扩展点。中间件与请求格式无关——均作用于 `GatewayContext`。

## 目录结构

```
middleware/
├── types.ts               # Middleware 类型定义
├── index.ts               # applyMiddlewares 执行器 + 导出已注册中间件
├── request/
│   ├── api-key-auth.ts            # API Key 鉴权中间件（SHA-256 哈希、内存缓存 + LISTEN 热更新）
│   ├── normalize-tool-calls.ts    # 请求工具调用 ID 规范化（UUID v5 映射）
│   └── index.ts                   # 导出所有请求中间件
└── response/
    ├── normalize-tool-calls.ts    # 响应工具调用 ID 规范化（UUID v5 映射）
    └── index.ts                   # 导出所有响应中间件
```

## 中间件类型

```typescript
type Middleware = (ctx: GatewayContext) => Promise<void>;
```

在核心流程中的位置：
```
用户适配 → [请求中间件链] → 路由 → 提供商调用 → [响应中间件链] → 用户响应
```

- **请求中间件**：可访问 `ctx.request`、`ctx.requestModel`、`ctx.apiKey`
- **响应中间件**：可访问 `ctx.response`、`ctx.timing`、`ctx.routedModel`

## 已注册中间件

| 中间件                             | 阶段 | 说明                                                                                |
| ---------------------------------- | ---- | ----------------------------------------------------------------------------------- |
| `apiKeyAuth`                       | 请求 | API Key 鉴权；支持 Bearer Token 和 `?key=` 两种方式；`REQUIRE_API_KEY=false` 时跳过 |
| `normalizeChatToolCallIds`         | 请求 | 将 Chat 请求消息中所有工具调用 / 工具响应的 ID 映射为 UUID v5；Embedding 请求跳过   |
| `normalizeResponseChatToolCallIds` | 响应 | 将提供商返回的非流式 Chat 响应中工具调用 ID 映射为 UUID v5；Embedding 响应跳过      |

## 新增 / 重构 / 删除向导

### 新增中间件

1. 在 `src/middleware/request/`（请求前）或 `response/`（响应后）下新建文件
2. 实现 `Middleware` 类型的函数，操作 `ctx` 或抛出 `GatewayError` 中断链路：
    ```typescript
    import type { Middleware } from '../types';
    import { GatewayError } from '../../utils';

    export const myMiddleware: Middleware = async (ctx) => {
      // 操作 ctx，或抛出 GatewayError 中断链路
    };
    ```
3. 在 `src/middleware/request/index.ts`（或 `response/index.ts`）中导出新中间件
4. 在 `src/app/process.ts` 的 `requestMiddlewares`（或 `responseMiddlewares`）数组中添加新中间件

### 重构

- **调整执行顺序**：修改 `src/app/process.ts` 中中间件数组的排列顺序
- **更改鉴权方式**：修改 `request/api-key-auth.ts`，不影响其他中间件
- **添加全局配置**：`REQUIRE_API_KEY` 等环境变量在各自中间件内部读取，不需内常参数传递

### 删除中间件

1. 删除 `src/middleware/request/`（或 `response/`）中的对应文件
2. 从 `request/index.ts` 或 `response/index.ts` 中移除导出
3. 从 `src/app/process.ts` 中的中间件数组移除该中间件
