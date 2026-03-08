# Linguist — LLM Gateway 开发指南

> **项目概述、快速启动、API 文档**：参见 [README.md](../README.md)
> **提交规范、分支管理、开发流程**：参见 [CONTRIBUTING.md](../CONTRIBUTING.md)
> **各模块详细说明**：参见 `src/<module>/README.md`（每个二级目录均有）

---

## 架构核心概念

### GatewayContext 贯穿全生命周期

`GatewayContext` 是整个请求处理流程的唯一载体对象，所有阶段均通过读写 `ctx` 的字段完成工作：

```
创建 ctx → 用户适配(填充 ctx.request) → 请求中间件(ctx)
  → 路由(填充 ctx.route) → 提供商请求适配(ctx.request + ctx.route.model)
  → 提供商调用 → 提供商响应适配(填充 ctx.response)
  → 响应中间件(ctx) → 用户响应适配(从 ctx 组装) → 发送
```

### 双层适配器模式

- **用户适配器** (`src/users/`)：转换客户端格式 ↔ 内部类型，按 `chat/` 和 `embedding/` 分类。
- **API 格式路由** (`src/api/`)：每种用户 API 格式独立定义端点和 model 提取逻辑，调用 `processChatCompletion` 将处理委托给核心流程。
- **提供商适配器** (`src/providers/`)：转换内部类型 ↔ 厂商 API 格式，每个提供商含三个独立部分：`request/`、`response/`、`client.ts`。

### 内部统一类型 (`src/types/`)

所有模块间通信使用统一类型：
- `GatewayContext` — 请求生命周期载体
- `InternalChatRequest` / `InternalChatResponse` — 聊天请求/响应（无 `model`、无 `id`）
- `InternalEmbeddingRequest` / `InternalEmbeddingResponse` — 嵌入请求/响应

---

## 编码约定

- 适配器文件统一命名：`request.adapter.ts`、`response.adapter.ts`、`client.ts`、`index.ts`
- 每个适配器目录必须有 `index.ts` 简化导入路径
- 接口定义放在对应分类的 `interface.ts` 中（如 `providers/chat/interface.ts`）
- 错误统一由 `handleError(err, res, userFormat)` 捕获，抛出 `GatewayError(statusCode, errorCode, message)`
- 核心流程编排在 `src/app/`（拆分为 `process.ts`、`stream.ts`、`helpers.ts`），入口在 `src/index.ts`，HTTP 配置在 `src/server.ts`，API 格式路由在 `src/api/`
- `InternalRequest` 不含 `model` 字段，提供商适配器从 `ctx.route.model` 取实际模型名
- 用户响应适配器接收 `GatewayContext`，从中取 `ctx.id`、`ctx.timestamp`、`ctx.requestModel`、`ctx.response` 组装最终响应
- Chat 支持流式（SSE）和非流式两种响应模式；Embedding 仅支持非流式
- **不需考虑向后兼容性**：项目尚未上线，可以自由修改现有接口或重构代码，无需保留旧版本兼容代码
- **管理 API 变更必须同步 `admin.http`**：每次新增、修改或删除 `src/admin/` 下的路由，都必须同步更新项目根目录的 `admin.http` 文件；`admin.http` 中仅保留已实现适配器的提供商示例，不包含用户侧 API
- **修改完成必须通过 ESLint 检查**：每次代码修改完成后，必须执行 `npx eslint . --max-warnings 0` 确保没有任何 ESLint 错误或警告，只有全部通过时才能停止

