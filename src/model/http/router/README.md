# src/router — 路由模块

> 项目总览：参见 [README.md](../README.md)
>
> 相关模块：[`src/config/README.md`](../config/README.md)（配置查询）、[`src/app/README.md`](../app/README.md)（调用方）

## 简介

将用户请求中的虚拟模型 ID（`ctx.requestModel`）解析为具体的提供商配置，并将路由结果写入 `GatewayContext`。路由失败时抛出 `GatewayError`。

## 目录结构

```
router/
├── index.ts          # 路由逻辑：route()、assertRouted()、能力推断函数
└── __tests__/
    └── index.test.ts # 单元测试
```

## 能力推断

router 模块会根据请求内容自动推断所需的能力标识，用于过滤不满足的后端：

### `inferChatCapabilities(req: InternalChatRequest): string[]`

- 消息包含图片/视频/音频/文件等多模态内容 → `'vision'`
- 请求定义了工具 (`tools`) → `'tools'`
- 启用了深度思考 (`thinking.type !== 'disabled'`) → `'thinking'`

> **注意**：`stream` 是传输格式偏好（SSE vs JSON），**不作为模型能力推断**。流式处理由 `process.ts` 层独立管理，不受路由层能力过滤影响。

### `inferEmbeddingCapabilities(req: InternalEmbeddingRequest): string[]`

- 输入包含图像或视频 → `'multimodal'`
- 启用了稀疏向量 (`sparse_embedding='enabled'`) → `'sparse_vector'`

## 主要函数

### `route(ctx: GatewayContext, expectedModelType?: 'chat' | 'embedding'): void`

1. **模型校验**：检查虚拟模型是否存在，不存在则抛出 `GatewayError(404, 'model_not_found')`
2. **类型校验**（可选）：如传入 `expectedModelType`，校验模型类型是否匹配，不匹配抛出 `GatewayError(400, 'model_type_mismatch')`
3. **能力推断**：从 `ctx.request` 自动推断所需能力（见上文）
4. **后端解析**：调用 `configManager.resolveAllBackends(ctx.requestModel, requiredCaps)` 获取满足能力要求的候选后端列表
5. **结果写入**：将首选后端写入 `ctx.route` 对象：`{ model, modelType, providerKind, providerId, providerConfig, strategy, capabilities }`，并记录 `timing.routed`
6. **错误处理**：
   - 无后端满足能力要求 → `GatewayError(400, 'capability_not_supported')`
   - 所有后端不可用 → `GatewayError(503, 'no_backend_available')`

### `assertRouted(ctx): asserts ctx is RoutedGatewayContext`

TypeScript 类型守卫，调用 `route` 后对 `ctx` 进行类型收窄。收窄后 `ctx.route` 为非 `undefined`，其所有子字段均可直接访问。

## 使用方式

```typescript
import { route, assertRouted } from '../router';

// 带类型校验的路由（可选）
route(ctx, 'chat');              // 只接受 chat 模型，不匹配则抛 400
// 或
route(ctx, 'embedding');         // 只接受 embedding 模型

// 路由后类型收窄
assertRouted(ctx);

const kind = ctx.route.providerKind;  // string（非 undefined）
const model = ctx.route.model;        // 提供商侧实际模型名
```

## 错误码

| 错误码                     | 场景                     |
| -------------------------- | ------------------------ |
| `model_not_found`          | 虚拟模型不存在           |
| `model_type_mismatch`      | 模型类型与预期不符       |
| `capability_not_supported` | 无后端满足所需能力       |
| `no_backend_available`     | 所有后端不可用           |
| `route_error`              | 路由字段缺失（内部错误） |

## 新增 / 重构 / 删除向导

### 新增路由逻辑

- 虚拟模型和提供商的关联通过管理 API 配置，`router/index.ts` 不需要修改
- 如需新增路由策略，在 `src/config/manager.ts` 的 `resolveAllBackends` 方法中添加——参见 [`src/config/README.md`](../config/README.md)
- 如需新增能力推断规则，在对应的 `infer*Capabilities` 函数中添加

### 重构

- **扩展 ctx.route 字段**：在 `src/types/context.ts` 中扩展 `GatewayContext.route` 和 `RoutedGatewayContext` 类型，再在 `router/index.ts` 中赋值
- **更换路由来源**：修改 `router/index.ts` 中的 `configManager.resolveAllBackends` 调用，替换为其他路由来源（如读取文件、远程配置等）

### 删除

路由模块是核心流程必需组件，不应删除。如需缩减责任，可将路由逻辑直接内联到 `src/app/process.ts` 中并删除此目录。
