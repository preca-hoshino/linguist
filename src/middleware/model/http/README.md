# src/middleware/model/http — 模型 HTTP 中间件

> 父模块：参见 [model/README.md](../README.md)、[middleware/README.md](../../README.md)

## 简介

包含模型 HTTP API 请求链中的所有中间件实现，分为**请求阶段**和**响应阶段**两个子目录。中间件均作用于 `ModelHttpContext`，通过 `applyMiddlewares()` 顺序执行。

## 目录结构

```
http/
├── request/                         # 请求阶段中间件（路由解析前/后）
│   ├── allowed-model-check.ts       # App 模型白名单校验（name → 内部 ID 比对）
│   ├── normalize-tool-calls.ts      # 请求工具调用 ID 规范化（UUID v5 映射）
│   ├── rate-limit.ts                # 虚拟模型级别 RPM/TPM 限流（路由后执行）
│   ├── index.ts                     # 导出：allowedModelCheck, normalizeChatToolCallIds, rateLimit
│   └── __tests__/                   # 单元测试
└── response/                        # 响应阶段中间件
    ├── normalize-tool-calls.ts      # 响应工具调用 ID 规范化（UUID v5 映射）
    ├── token-accounting.ts          # Token 结算（从响应提取实际用量更新 TPM 计数器）
    ├── index.ts                     # 导出：normalizeResponseChatToolCallIds, tokenAccounting
    └── __tests__/                   # 单元测试
```

## 执行位置

在核心流程 `src/model/http/app/process.ts` 中的注册位置：

```
请求中间件链（apiKeyAuth → allowedModelCheck → normalizeChatToolCallIds）
  ↓ 路由解析（router.route()）
路由后中间件链（rateLimit）
  ↓ 提供商调用
响应中间件链（normalizeResponseChatToolCallIds → tokenAccounting）
```

## 各中间件说明

### `allowed-model-check.ts`

执行时机：`apiKeyAuth` 之后，路由解析之前。

- 若 App 无模型白名单（`allowedModelIds` 为空数组），放行所有模型
- 将请求模型名转换为内部 ID（通过 `configManager.getVirtualModelConfig(name)`）
- 内部 ID 不在 `allowedModelIds` 中则返回 `403 forbidden`

### `normalize-tool-calls.ts`（请求/响应各一份）

- **请求侧**：将历史消息中所有工具调用和工具响应的 `tool_call_id` 通过 UUID v5 规范化，确保跨 API 格式转换后 ID 保持确定性一致
- **响应侧**：将提供商返回的 Chat 响应（非流式）中工具调用 ID 同步映射；Embedding 响应自动跳过

### `rate-limit.ts`

执行时机：路由解析后（`ctx.route` 已填充）。

- 检查虚拟模型的 RPM/TPM 限制（`rpmLimit / tpmLimit`）
- 超标返回 `429 rate_limit_exceeded`
- 通过后扣减虚拟模型和提供商模型双维度 RPM 计数器

### `token-accounting.ts`

执行时机：提供商响应成功返回后。

- 从 `ctx.response.usage.total_tokens` 提取实际 Token 消耗
- 更新虚拟模型和提供商模型双维度 TPM 计数器

## 新增请求/响应中间件

参见 [middleware/README.md 的新增向导](../../README.md#新增--重构--删除向导)
