---
description: '管理 API 设计规范 — RESTful 惯例、响应格式、分页、幂等性、嵌套资源'
applyTo: 'src/admin/**/*.ts'
---

# 管理 API 设计规范

## 概述

本文件定义 Linguist 管理 API（`src/admin/`）的设计规范，基于 [Stripe API 设计哲学](https://stripe.com/docs/api) 的四大支柱（简洁性、可预测性、可组合性、向后兼容性）提炼而来。所有管理 API 路由 **必须** 遵循以下约定。

**核心理念** — API 是面向前端开发者的产品界面，每个端点、每个字段、每条错误消息都应以「让调用方生活更轻松」为设计目标。

---

## 一、REST 基础惯例

### 1. URL 命名规则

| 规则       | 说明                                   | 示例                                            |
| ---------- | -------------------------------------- | ----------------------------------------------- |
| 复数名词   | 集合端点始终使用复数                   | `/admin/users`、`/admin/apps`                   |
| 禁止动词   | 动作由 HTTP 方法表达，URL 中不出现动词 | ❌ `/admin/createUser`                           |
| kebab-case | 多词路径片段使用连字符                 | `/admin/virtual-models`、`/admin/provider-mcps` |
| 无末尾斜杠 | URL 不得以 `/` 结尾                    | ✅ `/admin/users` ❌ `/admin/users/`              |
| 资源 ID    | 单资源用 `/:id` 路径参数               | `/admin/users/:id`、`/admin/apps/:id`           |

**DO** — 正确 URL 示例：

```typescript
// ✅ 正确 — 复数 + kebab-case
router.get('/', listUsers);           // GET  /admin/users
router.get('/:id', getUser);         // GET  /admin/users/:id
router.post('/', createUser);        // POST /admin/users
router.patch('/:id', updateUser);    // PATCH /admin/users/:id
router.delete('/:id', deleteUser);   // DELETE /admin/users/:id

// ✅ 正确 — 嵌套子资源
router.get('/:id/models', listProviderModels);  // GET /admin/providers/:id/models
```

```typescript
// ❌ 错误 — 单数名词、包含动词、末尾斜杠
router.get('/user', listUsers);           // 应为 /users
router.post('/create-app', createApp);    // 应为 POST /apps
router.get('/users/', listUsers);         // 不应有末尾斜杠
```

### 2. HTTP 方法语义

| 方法     | 用途             | 请求体         | 成功状态码 | 响应体                          |
| -------- | ---------------- | -------------- | ---------- | ------------------------------- |
| `GET`    | 获取资源或列表   | 无             | `200`      | 单个对象或列表                  |
| `POST`   | **创建**资源     | 完整或部分字段 | `201`      | 完整新建对象                    |
| `PATCH`  | **局部更新**资源 | 仅需变更字段   | `200`      | 完整更新后对象                  |
| `DELETE` | 删除资源         | 无             | `200`      | `{ id, object, deleted: true }` |

> **【历史遗留】** 当前部分路由使用 `POST /:id` 做更新（如 `POST /admin/users/:id`），这与 Stripe 方法语义相悖。规范要求新路由使用 `PATCH /:id`，旧路由建议后续迁移，不强制立即修改。

**DO** — 正确的方法使用：

```typescript
// ✅ 正确 — POST 仅用于创建
router.post('/', async (req, res) => {
  const user = await createUser(req.body);
  res.status(201).json({ object: 'user', ...user });
});

// ✅ 正确 — PATCH 用于局部更新
router.patch('/:id', async (req, res) => {
  const user = await updateUser(req.params.id, req.body);
  res.json({ object: 'user', ...user });
});

// ✅ 正确 — DELETE 返回删除确认
router.delete('/:id', async (req, res) => {
  await deleteUser(req.params.id);
  res.json({ id: req.params.id, object: 'user', deleted: true });
});
```

```typescript
// ❌ 错误 — POST 用于更新（历史遗留，新代码禁止）
router.post('/:id', async (req, res) => {
  const user = await updateUser(req.params.id, req.body);
  res.json({ object: 'user', ...user });
});
```

### 3. 字段命名规范

| 规则         | 说明                         | 示例                                                                    |
| ------------ | ---------------------------- | ----------------------------------------------------------------------- |
| `snake_case` | 所有 JSON 字段使用蛇形命名   | `created_at`、`is_active`、`avatar_url`                                 |
| 肯定式布尔   | 布尔字段使用肯定语义         | `is_active`（非 `disabled`）、`has_more`（非 `no_more`）                |
| 枚举字符串   | 状态用字符串枚举而非布尔标志 | `"status": "active"` 而非 `"is_active": true` + `"is_suspended": false` |
| 时间戳       | 统一使用 ISO 8601 字符串     | `"created_at": "2026-05-02T10:30:00.000Z"`                              |

**DO** — 正确字段命名：

```typescript
// ✅ 正确 — snake_case + 肯定式布尔 + 时间戳
res.json({
  object: 'provider',
  id: 'prov_abc123',
  name: 'OpenAI',
  kind: 'openai',
  is_active: true,
  created_at: '2026-05-02T10:30:00.000Z',
  updated_at: '2026-05-02T12:00:00.000Z',
});
```

```typescript
// ❌ 错误 — camelCase、否定式布尔
res.json({
  object: 'provider',
  id: 'prov_abc123',
  isDisabled: false,       // 应为 is_active
  createdAt: '...',        // 应为 created_at
});
```

---

## 二、响应格式标准化

### 4. 单一对象响应

所有返回单个资源的端点 **必须** 包含以下字段：

| 字段         | 类型     | 说明                                               |
| ------------ | -------- | -------------------------------------------------- |
| `object`     | `string` | 资源类型标识（如 `"user"`、`"app"`、`"provider"`） |
| `id`         | `string` | 资源唯一标识                                       |
| `created_at` | `string` | ISO 8601 创建时间                                  |
| `updated_at` | `string` | ISO 8601 最后更新时间                              |

**DO** — 正确单对象响应：

```typescript
// ✅ 正确 — 始终包含 object / id / created_at / updated_at
router.get('/:id', async (req, res) => {
  const app = await getAppById(req.params.id);
  if (!app) throw new GatewayError(404, 'not_found', `App ${req.params.id} not found`);
  res.json({
    object: 'app',
    id: app.id,
    name: app.name,
    is_active: app.is_active,
    created_at: app.created_at,
    updated_at: app.updated_at,
  });
});
```

```typescript
// ❌ 错误 — 缺少 object 字段，字段名不一致
res.json({ id: app.id, name: app.name, active: app.is_active });
```

#### ID 前缀体系（建议性规范）

推荐为每种资源类型定义人类可读的 ID 前缀，新资源采用，旧资源渐进迁移：

| 前缀    | 资源类型   | 示例            |
| ------- | ---------- | --------------- |
| `user_` | 用户       | `user_a1b2c3d4` |
| `app_`  | 应用       | `app_x9y8z7w6`  |
| `prov_` | 提供商     | `prov_m5n4o3p2` |
| `pm_`   | 提供商模型 | `pm_q1r2s3t4`   |
| `vm_`   | 虚拟模型   | `vm_u5v6w7x8`   |
| `mcp_`  | MCP 服务器 | `mcp_y9z0a1b2`  |

**优势**：日志分析时可一眼识别对象类型；可快速发现传错对象类型的调用错误。

### 5. 列表响应

所有返回集合的端点 **必须** 使用统一列表格式：

```typescript
interface ListResponse<T> {
  object: 'list';
  url: string;       // 当前请求路径（不含查询参数），便于调试
  data: T[];         // 资源数组
  has_more: boolean; // 是否还有更多数据
  total: number;     // 符合条件的总记录数
}
```

**DO** — 正确列表响应：

```typescript
// ✅ 正确 — 统一列表格式，支持搜索与过滤
router.get('/', async (req, res) => {
  const { search, limit, offset, is_active } = req.query;
  const limitNum = typeof limit === 'string' ? Math.min(Number.parseInt(limit, 10), 100) : 10;
  const offsetNum = typeof offset === 'string' ? Math.max(Number.parseInt(offset, 10), 0) : 0;

  const result = await listApps({
    limit: limitNum,
    offset: offsetNum,
    search: typeof search === 'string' ? search : undefined,
    is_active: typeof is_active === 'string' ? is_active === 'true' : undefined,
  });

  const data = result.data.map((a) => ({ object: 'app' as const, ...a }));

  res.json({
    object: 'list',
    url: '/admin/apps',
    data,
    has_more: result.has_more,
    total: result.total,
  });
});
```

```typescript
// ❌ 错误 — 缺少 has_more / total / object，无分页元信息
res.json({ apps: result.data });
```

### 6. 分页规范

管理 API **仅使用 offset-based 分页**。管理面板场景下的数据集规模可控，offset 分页简单直观，不需要游标分页。

| 参数     | 类型      | 默认值 | 说明                 |
| -------- | --------- | ------ | -------------------- |
| `limit`  | `integer` | `10`   | 每页条数，范围 1–100 |
| `offset` | `integer` | `0`    | 偏移量，从 0 开始    |

**DO** — 正确分页实现：

```typescript
// ✅ 正确 — 参数校验 + 边界限制
const limitNum = typeof limit === 'string' && limit !== ''
  ? Math.min(Math.max(Number.parseInt(limit, 10), 1), 100)
  : 10;
const offsetNum = typeof offset === 'string' && offset !== ''
  ? Math.max(Number.parseInt(offset, 10), 0)
  : 0;
```

```typescript
// ❌ 错误 — 未限制 limit 上限，未校验 offset 合法性
const limitNum = Number.parseInt(limit as string, 10) || 10;  // 可传入 99999
const offsetNum = Number.parseInt(offset as string, 10);       // NaN 未处理
```

### 7. 删除响应

所有 `DELETE` 端点 **必须** 返回统一的删除确认格式：

```typescript
interface DeletedResponse {
  id: string;
  object: string;
  deleted: true;
}
```

**DO** — 正确删除响应：

```typescript
// ✅ 正确
router.delete('/:id', async (req, res) => {
  const deleted = await deleteApp(req.params.id);
  if (!deleted) throw new GatewayError(404, 'not_found', `App ${req.params.id} not found`);
  res.json({ id: req.params.id, object: 'app', deleted: true });
});
```

```typescript
// ❌ 错误 — 返回 204 No Content（无响应体），丢失确认信息
router.delete('/:id', async (req, res) => {
  await deleteApp(req.params.id);
  res.status(204).end();
});
```

### 8. Metadata 字段（可扩展键值存储）

所有主要业务对象 **推荐** 支持 `metadata` 字段，允许前端附加自定义键值对而无需修改 API 结构：

| 约束         | 值                             |
| ------------ | ------------------------------ |
| 最多键数     | 50                             |
| 键名最大长度 | 40 字符                        |
| 值最大长度   | 500 字符                       |
| 敏感数据     | **禁止存储** PII、凭据、密钥等 |

```typescript
// ✅ 正确 — metadata 作为可选扩展字段
interface AppResponse {
  object: 'app';
  id: string;
  name: string;
  // ...
  metadata?: Record<string, string>;
}
```

> **注意**：metadata **不会自动传播**到关联对象（如创建 app 时传入的 metadata 不会复制到其 keys 上），需要时由服务端显式处理。

---

## 三、错误处理标准化

> 错误码速查表与 `GatewayError` 使用规范详见 [错误处理规范](./error-handling.instructions.md)。本节仅补充管理 API 特有的错误格式约束。

### 9. 统一错误响应格式

所有管理 API 错误 **必须** 使用 `handleAdminError()`（定义于 `src/admin/error.ts`），输出标准结构：

```typescript
interface ApiErrorResponse {
  error: {
    code: string;        // 机器可读错误码（如 'invalid_request', 'not_found'）
    message: string;     // 人类可读描述，必须可操作
    type: ApiErrorType;  // 错误分类
    param: string | null; // 关联的参数字段名，无则为 null
  };
}
```

**DO** — 可操作的错误消息：

```typescript
// ✅ 正确 — 告诉调用者具体缺什么
throw new GatewayError(400, 'invalid_request', 'Field "name" is required and must be a non-empty string');

// ✅ 正确 — 告诉调用者什么值不合法
throw new GatewayError(400, 'invalid_request', 'Parameter "limit" must be between 1 and 100');

// ✅ 正确 — 指定关联参数
throw new GatewayError(400, 'invalid_request', 'Invalid model type').withParam('model_type');
```

```typescript
// ❌ 错误 — 不可操作的消息
throw new GatewayError(400, 'invalid_request', 'Something went wrong');
throw new GatewayError(400, 'invalid_request', 'Error');
throw new GatewayError(400, 'bad_request', 'Invalid input');  // 不指明哪个字段
```

### 10. HTTP 状态码速查

| 状态码 | 含义       | 使用场景                                        |
| ------ | ---------- | ----------------------------------------------- |
| `200`  | 成功       | GET / PATCH / DELETE 成功                       |
| `201`  | 已创建     | POST 创建资源成功                               |
| `400`  | 请求错误   | 参数缺失、格式错误、数值越界                    |
| `401`  | 未认证     | 缺少或无效的 JWT Token                          |
| `403`  | 无权限     | Token 有效但权限不足                            |
| `404`  | 未找到     | 资源 ID 不存在                                  |
| `409`  | 冲突       | 唯一键重复（用户名、邮箱等）                    |
| `422`  | 校验失败   | 请求体字段级校验失败（推荐未来引入 zod 后使用） |
| `500`  | 服务端错误 | 未预期的内部异常                                |

> **500 处理原则**：将 500 视为「不确定状态」— 操作可能已部分执行。建议调用方配合幂等性 Key 安全重试。

---

## 四、幂等性

### 11. 幂等性键（Idempotency Key）

已通过 `idempotencyMiddleware`（`src/admin/idempotency.ts`）实现。所有 `POST` 请求自动受幂等性保护。

**客户端要求**：
- 所有 `POST` 请求应携带 `Idempotency-Key` 请求头
- Key 格式建议：`<resource>_<uuid>`（如 `app_550e8400-e29b-41d4-a716-446655440000`）

**服务端行为**：

1. 首遇 Key → 正常执行业务逻辑，将响应（状态码 + JSON 体）写入 `idempotency_keys` 表
2. 再次命中 → 直接返回缓存的响应，**不重复执行业务逻辑**
3. 幂等性仅对 `POST` 方法生效（`GET` / `PATCH` / `DELETE` 天然幂等）

```typescript
// 客户端示例 — 安全重试模式
const idempotencyKey = `app_${crypto.randomUUID()}`;

async function safeCreateApp(body: CreateAppBody): Promise<App> {
  const res = await fetch('/admin/apps', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,  // 同一 Key 可安全重试
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  return res.json();
}
```

---

## 五、嵌套资源与关联

### 12. 嵌套资源路由模式

**规范推荐**：强归属关系使用嵌套路由，可独立存在的资源使用平铺路由。

| 关系                           | 推荐模式 | 示例                                         |
| ------------------------------ | -------- | -------------------------------------------- |
| 强归属（子资源离开父级无意义） | 嵌套     | `GET /admin/providers/:pid/models`           |
| 弱关联（子资源可独立存在）     | 平铺     | `GET /admin/provider-models?provider_id=xxx` |

```
# ✅ 推荐 — 嵌套路由（Models 属于 Provider）
GET    /admin/model/providers/:pid/models        # 列出某提供商的模型
POST   /admin/model/providers/:pid/models        # 为提供商添加模型
PATCH  /admin/model/providers/:pid/models/:mid   # 更新模型
DELETE /admin/model/providers/:pid/models/:mid   # 删除模型

# ✅ 可接受 — 平铺路由 + 查询过滤（子资源可独立管理）
GET    /admin/provider-models?provider_id=xxx    # 过滤某提供商的模型
```

> **【当前状态】** 现有路由使用平铺模式（`/admin/model/provider-models`）。新路由按上方推荐选择，旧路由无需强制迁移。

### 13. 关联字段表示

在对象响应中表示关联时，默认仅返回关联对象的 ID：

```typescript
// ✅ 正确 — 默认返回关联 ID
{
  "object": "virtual_model",
  "id": "vm_abc123",
  "name": "gpt-4-latest",
  "provider_model_id": "pm_xyz789",   // 关联 ID，前端需要时再请求
  "provider_id": "prov_def456",
  "created_at": "2026-05-02T10:00:00Z"
}
```

> **expand 机制（Roadmap）**：未来可选支持 `?expand=provider_model` 查询参数，在单次请求中展开关联对象。当前不实现。

---

## 六、参数校验与查询

### 14. 查询参数规范

| 参数        | 类型              | 用途                       | 示例               |
| ----------- | ----------------- | -------------------------- | ------------------ |
| `search`    | `string`          | 模糊搜索（名称、标识等）   | `?search=openai`   |
| `limit`     | `integer`         | 每页条数（1–100，默认 10） | `?limit=20`        |
| `offset`    | `integer`         | 分页偏移（≥0，默认 0）     | `?offset=40`       |
| `is_active` | `boolean`         | 按启用状态过滤             | `?is_active=true`  |
| `sort`      | `string`          | 排序字段                   | `?sort=created_at` |
| `order`     | `'asc' \| 'desc'` | 排序方向                   | `?order=desc`      |
| `<field>`   | `string`          | 按其他字段精确过滤         | `?kind=openai`     |

**DO** — 正确查询参数处理：

```typescript
// ✅ 正确 — 类型安全的查询参数解析
router.get('/', async (req, res) => {
  const { search, limit, offset, is_active, kind, sort, order } = req.query;

  // 分页参数：类型转换 + 边界限制
  const limitNum = typeof limit === 'string' && limit !== ''
    ? Math.min(Math.max(Number.parseInt(limit, 10), 1), 100)
    : 10;
  const offsetNum = typeof offset === 'string' && offset !== ''
    ? Math.max(Number.parseInt(offset, 10), 0)
    : 0;

  // 布尔参数
  const isActiveBool = typeof is_active === 'string'
    ? is_active.toLowerCase() === 'true'
    : undefined;

  // 枚举参数 — 白名单校验
  const validKinds = new Set(['openai', 'anthropic', 'gemini']);
  const kindStr = typeof kind === 'string' && validKinds.has(kind) ? kind : undefined;

  // 排序参数 — 白名单校验
  const validSortFields = new Set(['created_at', 'updated_at', 'name']);
  const sortField = typeof sort === 'string' && validSortFields.has(sort) ? sort : undefined;
  const sortOrder = order === 'desc' ? 'DESC' : 'ASC';

  const result = await listProviders({
    limit: limitNum,
    offset: offsetNum,
    search: typeof search === 'string' ? search : undefined,
    is_active: isActiveBool,
    kind: kindStr,
    sort: sortField,
    order: sortOrder,
  });

  // ...
});
```

```typescript
// ❌ 错误 — 无类型转换、无边界校验、无白名单
router.get('/', async (req, res) => {
  const result = await listProviders(req.query as any);  // 直接透传，SQL 注入风险
  res.json(result);
});
```

### 15. 请求体验证

所有 `POST` / `PATCH` 路由处理器 **必须** 在函数开头验证请求体：

```typescript
// ✅ 正确 — 逐字段验证 + 明确的错误消息
router.post('/', async (req, res) => {
  const body = req.body as { name?: string; kind?: string; base_url?: string };

  // 1. 必填字段检查
  if (typeof body.name !== 'string' || body.name === '') {
    throw new GatewayError(400, 'invalid_request', 'Field "name" is required and must be a non-empty string');
  }
  if (typeof body.kind !== 'string' || body.kind === '') {
    throw new GatewayError(400, 'invalid_request', 'Field "kind" is required and must be a non-empty string');
  }

  // 2. 格式校验
  if (body.base_url !== undefined && typeof body.base_url !== 'string') {
    throw new GatewayError(400, 'invalid_request', 'Field "base_url" must be a string');
  }

  // 3. 枚举值校验
  const validKinds = new Set(['openai', 'anthropic', 'gemini']);
  if (!validKinds.has(body.kind)) {
    throw new GatewayError(400, 'invalid_request', `Unsupported provider kind: ${body.kind}`);
  }

  const provider = await createProvider(body);
  res.status(201).json({ object: 'provider', ...provider });
});
```

> **优化建议**：推荐未来引入 [`zod`](https://zod.dev/) 做声明式校验，替代手写 if-else 链，此时校验失败使用 `422` 状态码。

---

## 七、Webhook（可选扩展）

当前管理 API 不包含 Webhook 事件推送。如未来需要（如通知前端数据变更），遵循以下 Stripe 最佳实践：

| 原则             | 做法                                              |
| ---------------- | ------------------------------------------------- |
| **幂等处理**     | 记录已处理的事件 ID，重复事件直接跳过             |
| **先响应后处理** | 收到事件后立即返回 `200 OK`，然后异步执行业务逻辑 |
| **签名验证**     | 使用 HMAC 签名验证事件来源，防止伪造              |
| **兜底对账**     | 定时从 API 主动拉取事件，弥补 Webhook 遗漏        |

---

## 八、常见模式速查

### 完整 CRUD 端点模板

```typescript
import { Router } from 'express';
import type { Request, Response } from 'express';
import { createLogger, GatewayError, logColors } from '@/utils';
import { handleAdminError } from './error';

const logger = createLogger('Admin:Resource', logColors.bold + logColors.blue);
const router = Router();

// GET /admin/resources — 列表（支持搜索、过滤、分页、排序）
router.get('/', async (req: Request, res: Response) => {
  try {
    const { search, limit, offset } = req.query;
    const limitNum = typeof limit === 'string' ? Math.min(Number.parseInt(limit, 10), 100) : 10;
    const offsetNum = typeof offset === 'string' ? Math.max(Number.parseInt(offset, 10), 0) : 0;
    const searchStr = typeof search === 'string' ? search : undefined;

    const { data: items, total, has_more } = await listResources({ limit: limitNum, offset: offsetNum, search: searchStr });

    res.json({
      object: 'list',
      url: '/admin/resources',
      data: items.map((r) => ({ object: 'resource' as const, ...r })),
      total,
      has_more,
    });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// GET /admin/resources/:id — 获取详情
router.get('/:id', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const resource = await getResourceById(req.params.id);
    if (!resource) throw new GatewayError(404, 'not_found', `Resource ${req.params.id} not found`);
    res.json({ object: 'resource', ...resource });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// POST /admin/resources — 创建
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name } = req.body as { name?: string };
    if (typeof name !== 'string' || name === '') {
      throw new GatewayError(400, 'invalid_request', 'Field "name" is required and must be a non-empty string');
    }
    const resource = await createResource(req.body);
    logger.info({ id: resource.id, name }, 'Resource created');
    res.status(201).json({ object: 'resource', ...resource });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// PATCH /admin/resources/:id — 局部更新
router.patch('/:id', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const resource = await updateResource(req.params.id, req.body);
    if (!resource) throw new GatewayError(404, 'not_found', `Resource ${req.params.id} not found`);
    res.json({ object: 'resource', ...resource });
  } catch (error) {
    handleAdminError(error, res);
  }
});

// DELETE /admin/resources/:id — 删除
router.delete('/:id', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const deleted = await deleteResource(req.params.id);
    if (!deleted) throw new GatewayError(404, 'not_found', `Resource ${req.params.id} not found`);
    res.json({ id: req.params.id, object: 'resource', deleted: true });
  } catch (error) {
    handleAdminError(error, res);
  }
});

export { router };
```

### 唯一约束冲突处理模式

```typescript
// ✅ 正确 — 捕获数据库唯一约束冲突 → 409
router.post('/', async (req, res) => {
  try {
    const resource = await createResource(req.body);
    res.status(201).json({ object: 'resource', ...resource });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    if (errMsg.includes('duplicate key') || errMsg.includes('unique')) {
      handleAdminError(new GatewayError(409, 'conflict', 'Resource name already exists'), res);
      return;
    }
    handleAdminError(error, res);
  }
});
```

---

## 项目参考

- `src/admin/index.ts` — 路由聚合与中间件挂载
- `src/admin/error.ts` — `handleAdminError()` 统一错误处理器
- `src/admin/idempotency.ts` — POST 幂等性中间件
- `src/admin/apps.ts` — Stripe 风格完整实现参考（object / delete / idempotency）
- `src/admin/users.ts` — 混合模式参考（含需要迁移的 POST 更新路由）
- `src/admin/auth.ts` — JWT Bearer Token 认证中间件
- `src/types/api.ts` — `ApiErrorResponse` / `ApiErrorType` 类型定义
- `.github/instructions/error-handling.instructions.md` — `GatewayError` 完整错误码速查表
- `.github/instructions/middleware.instructions.md` — 中间件编写规范
- `.github/instructions/code-style.instructions.md` — TypeScript 代码风格（导入、命名等）
