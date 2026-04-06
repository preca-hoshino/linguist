# src/router — 路由模块

> 项目总览：参见 [README.md](../README.md)
> 
> 相关模块：[`src/config/README.md`](../config/README.md)（配置查询）、[`src/app/README.md`](../app/README.md)（调用方）

## 简介

将用户请求中的虚拟模型 ID（`ctx.requestModel`）解析为具体的提供商配置，并将路由结果写入 `GatewayContext`。路由失败时抛出 `GatewayError(404)`。

## 目录结构

```
router/
└── index.ts   # 导出 route(ctx) 和 assertRouted(ctx)
```

## 主要函数

### `route(ctx: GatewayContext): void`

1. 调用 `configManager.resolveAllBackends(ctx.requestModel)` 获取排序后的全部候选后端列表
2. 将首选后端写入 `ctx.route` 对象：`{ model, modelType, providerKind, providerId, providerConfig, strategy, capabilities }`，并记录 `timing.routed`
3. 如模型不存在，抛出 `GatewayError(404, 'model_not_found', ...)`
4. 如模型类型与请求能力不匹配，抛出 `GatewayError(400, 'model_type_mismatch', ...)`

### `assertRouted(ctx): asserts ctx is RoutedGatewayContext`

TypeScript 类型守卫，调用 `route` 后对 `ctx` 进行类型收窄。收窄后 `ctx.route` 为非 `undefined`，其所有子字段均可直接访问。

## 使用方式

```typescript
import { route, assertRouted } from '../router';

route(ctx);              // 写入路由信息（失败时抛异常）
assertRouted(ctx);       // TypeScript 类型收窄

const kind = ctx.route.providerKind;  // string（非 undefined）
const model = ctx.route.model;        // 提供商侧实际模型名
```

## 新增 / 重构 / 删除向导

### 新增路由逻辑

- 虚拟模型和提供商的关联通过管理 API 配置，`router/index.ts` 不需要修改
- 如需新增路由策略，在 `src/config/manager.ts` 的 `resolveAllBackends` 方法中添加——参见 [`src/config/README.md`](../config/README.md)

### 重构

- **扩展 ctx.route 字段**：在 `src/types/context.ts` 中扩展 `GatewayContext.route` 和 `RoutedGatewayContext` 类型，再在 `router/index.ts` 中赋值
- **更换路由来源**：修改 `router/index.ts` 中的 `configManager.resolveAllBackends` 调用，替换为其他路由来源（如读取文件、远程配置等）

### 删除

路由模块是核心流程必需组件，不应删除。如需缩减责任，可将路由逻辑直接内联到 `src/app/process.ts` 中并删除此目录。
