# src/middleware — 中间件模块

> 项目总览：参见 [README.md](../README.md)
> 
> 相关模块：[`src/model/http/app/README.md`](../model/http/app/README.md)（执行位置）、[`src/model/http/users/README.md`](../model/http/users/README.md)（格式无关）

## 简介

定义中间件类型，提供顺序执行中间件链的执行器。中间件是在请求处理各阶段插入横切逻辑（鉴权、限流、日志等）的扩展点。中间件与请求格式无关——均作用于 `ModelHttpContext`（模型侧）或在 MCP 连接建立阶段。

## 目录结构

```
middleware/
├── types.ts                          # Middleware 类型定义（ModelHttpContext → void）
├── index.ts                          # applyMiddlewares 执行器 + 统一导出
├── common/                           # 跨模型/MCP 共享中间件
│   ├── api-key-auth.ts               #   API Key 鉴权（通过 App 缓存验证，写入 ctx.appId/appName）
│   ├── index.ts                      #   导出 apiKeyAuth
│   └── __tests__/                    #   单元测试
├── mcp/                              # MCP 专属中间件（目前为 Phase 4 占位）
│   ├── tool-acl.ts                   #   工具访问控制列表（TODO: 按 App 配置过滤可访问工具）
│   └── call-throttle.ts              #   工具调用频率防护（TODO: 防屏刷与调用均衡）
└── model/                            # 模型 API 专属中间件
    └── http/                         #   HTTP 请求侧
        ├── request/                  #   请求中间件
        │   ├── api-key-auth.ts       #     （已移至 common/，此处仅保留路径引用）
        │   ├── allowed-model-check.ts#     App 模型白名单校验（name → 内部 ID 比对）
        │   ├── normalize-tool-calls.ts#    请求工具调用 ID 规范化（UUID v5 映射）
        │   ├── rate-limit.ts         #     RPM/TPM 流控（虚拟模型级别检查 + RPM 扣减）
        │   ├── index.ts              #     导出所有请求中间件
        │   └── __tests__/            #     单元测试
        └── response/                 #   响应中间件
            ├── normalize-tool-calls.ts#    响应工具调用 ID 规范化（UUID v5 映射）
            ├── token-accounting.ts   #     TPM Token 结算（从响应提取实际用量更新计数器）
            ├── index.ts              #     导出所有响应中间件
            └── __tests__/            #     单元测试
```

## 中间件类型

```typescript
type Middleware = (ctx: ModelHttpContext) => void | Promise<void>;
```

- 同步中间件直接返回 `void`（无需异步操作时）
- 异步中间件返回 `Promise`（含 I/O 操作时，使用 `async` 关键词）

在核心流程中的位置：
```
用户适配 → [请求中间件链] → 路由 → [路由后中间件链] → 提供商调用 → [响应中间件链] → 用户响应
```

- **请求中间件**：可访问 `ctx.request`、`ctx.requestModel`、`ctx.apiKey`
- **路由后中间件**：可访问 `ctx.route`（路由已解析），用于流控检查
- **响应中间件**：可访问 `ctx.response`、`ctx.timing`、`ctx.route`

## 已注册中间件

| 中间件                             | 阶段   | 说明                                                                                    |
| ---------------------------------- | ------ | --------------------------------------------------------------------------------------- |
| `apiKeyAuth`                       | 请求   | API Key 鉴权；支持 Bearer Token 和 `?key=` 两种方式；`REQUIRE_API_KEY=false` 时跳过      |
| `allowedModelCheck`                | 请求   | App 模型白名单校验（name → 内部 ID，`allowedModelIds` 为空则放行所有模型）               |
| `normalizeChatToolCallIds`         | 请求   | 将 Chat 请求消息中所有工具调用 / 工具响应的 ID 映射为 UUID v5；Embedding 请求跳过        |
| `rateLimit`                        | 路由后 | RPM/TPM 流控：检查虚拟模型级别限制，超标返回 429；通过后扣减双维度 RPM 计数             |
| `normalizeResponseChatToolCallIds` | 响应   | 将提供商返回的非流式 Chat 响应中工具调用 ID 映射为 UUID v5；Embedding 响应跳过          |
| `tokenAccounting`                  | 响应   | 从提供商响应中提取实际 Token 消耗量，更新虚拟模型和提供商模型的 TPM 计数器              |

## 流控架构

RPM/TPM 限制分为两个层级，在不同阶段执行：

### 提供商模型级别（路由选择阶段）
- 在 `ConfigManager.resolveAllBackends` 中通过 `filterByRateLimit` 自动剔除已满载的后端
- RPM 或 TPM 任一达到上限的后端会被排除在候选列表之外
- 所有后端因流控耗尽时，路由返回 `503 No backend available`

### 虚拟模型级别（路由后中间件阶段）
- 在 `rateLimit` 中间件中检查虚拟模型的 RPM/TPM 总限制
- 超标时返回 `429 Rate limit exceeded`
- 通过后扣减虚拟模型和提供商模型双维度 RPM 计数

### TPM 结算（响应中间件阶段）
- 在 `tokenAccounting` 中间件中从 `ctx.response.usage.total_tokens` 提取真实 Token 消耗
- 更新虚拟模型和提供商模型双维度 TPM 计数器

### 限流引擎
- 使用纯内存固定时间窗口计数器，详见 `src/utils/rate-limiter.ts`
- `MemoryRateLimiterImpl` 类提供 `isRpmFull`/`isTpmFull`（查询）和 `incrementRpm`/`incrementTpm`（扣减）两类操作
- 每 60 秒通过 `setInterval` 自动清空所有计数桶，零外部依赖
- 提供 `getRpmUsage`/`getTpmUsage` 诊断方法用于管理 API

## 新增 / 重构 / 删除向导

### 新增中间件

1. 在 `src/middleware/model/http/request/`（请求前）或 `response/`（响应后）下新建文件
2. 实现 `Middleware` 类型的函数，操作 `ctx` 或抛出 `GatewayError` 中断链路：
    ```typescript
    import type { Middleware } from '../../types';
    import { GatewayError } from '../../../utils';

    export const myMiddleware: Middleware = async (ctx) => {
      // 操作 ctx，或抛出 GatewayError 中断链路
    };
    ```
3. 在 `src/middleware/model/http/request/index.ts`（或 `response/index.ts`）中导出新中间件
4. 在 `src/middleware/index.ts` 中追加再导出
5. 在 `src/model/http/app/process.ts` 的 `requestMiddlewares`、`postRouteMiddlewares`（或 `responseMiddlewares`）数组中添加新中间件

### 重构

- **调整执行顺序**：修改 `src/model/http/app/process.ts` 中中间件数组的排列顺序
- **更改鉴权方式**：修改 `common/api-key-auth.ts`，不影响其他中间件
- **添加全局配置**：`REQUIRE_API_KEY` 等环境变量在各自中间件内部读取，无需额外参数传递

### 删除中间件

1. 删除 `src/middleware/model/http/request/`（或 `response/`）中的对应文件
2. 从 `request/index.ts` 或 `response/index.ts` 中移除导出
3. 从 `src/middleware/index.ts` 中移除再导出
4. 从 `src/model/http/app/process.ts` 中的中间件数组移除该中间件
