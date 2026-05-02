---
description: '管理 API REST 设计 — URL 命名、HTTP 方法、响应格式、嵌套资源'
applyTo: 'src/admin/**/*.ts'
---

# 管理 API REST 设计

基于 Stripe API 设计哲学。所有管理 API 路由 **必须** 遵循以下约定。错误码与 `GatewayError` 用法见 [错误处理规范](./error-handling.instructions.md)。

---

## 一、URL 命名与 HTTP 方法

### 1. URL 命名规则

| 规则       | 说明                 | 示例                               |
| ---------- | -------------------- | ---------------------------------- |
| 复数名词   | 集合端点始终用复数   | `/admin/users`、`/admin/apps`      |
| 禁止动词   | 动作由 HTTP 方法表达 | ❌ `/admin/createUser`              |
| kebab-case | 多词路径用连字符     | `/admin/virtual-models`            |
| 无末尾斜杠 | URL 不得以 `/` 结尾  | ✅ `/admin/users` ❌ `/admin/users/` |
| 资源 ID    | 单资源用 `/:id`      | `/admin/users/:id`                 |

### 2. HTTP 方法语义

| 方法     | 用途             | 成功状态码 | 响应体                          |
| -------- | ---------------- | ---------- | ------------------------------- |
| `GET`    | 获取资源或列表   | `200`      | 单对象或列表                    |
| `POST`   | **创建**资源     | `201`      | 完整新建对象                    |
| `PATCH`  | **局部更新**资源 | `200`      | 完整更新后对象                  |
| `DELETE` | 删除资源         | `200`      | `{ id, object, deleted: true }` |

> **历史遗留**：部分路由用 `POST /:id` 做更新。新路由必须用 `PATCH /:id`，旧路由建议后续迁移。

```typescript
// ✅ POST 仅用于创建
router.post('/', async (req, res) => {
  const user = await createUser(req.body);
  res.status(201).json({ object: 'user', ...user });
});

// ✅ PATCH 用于局部更新
router.patch('/:id', async (req, res) => {
  const user = await updateUser(req.params.id, req.body);
  res.json({ object: 'user', ...user });
});

// ✅ DELETE 返回删除确认
router.delete('/:id', async (req, res) => {
  await deleteUser(req.params.id);
  res.json({ id: req.params.id, object: 'user', deleted: true });
});
```

### 3. 字段命名规范

| 规则         | 说明                                                     |
| ------------ | -------------------------------------------------------- |
| `snake_case` | 所有 JSON 字段用蛇形命名：`created_at`、`is_active`      |
| 肯定式布尔   | `is_active`（非 `disabled`）、`has_more`（非 `no_more`） |
| 时间戳       | ISO 8601：`"2026-05-02T10:30:00.000Z"`                   |

---

## 二、响应格式标准化

### 4. 单一对象响应

必须包含 `object`、`id`、`created_at`、`updated_at`：

```typescript
// ✅ 正确
router.get('/:id', async (req, res) => {
  const app = await getAppById(req.params.id);
  if (!app) throw new GatewayError(404, 'not_found', `App ${req.params.id} not found`);
  res.json({
    object: 'app', id: app.id, name: app.name,
    is_active: app.is_active, created_at: app.created_at, updated_at: app.updated_at,
  });
});
```

**ID 前缀体系**（建议性规范）：

| 前缀    | 资源类型 | 前缀    | 资源类型   |
| ------- | -------- | ------- | ---------- |
| `user_` | 用户     | `prov_` | 提供商     |
| `app_`  | 应用     | `pm_`   | 提供商模型 |
| `vm_`   | 虚拟模型 | `mcp_`  | MCP 服务器 |

### 5. 列表响应

统一格式，支持 offset-based 分页（参数：`limit` 1–100 默认 10，`offset` ≥0 默认 0）：

```typescript
interface ListResponse<T> {
  object: 'list';
  url: string;       // 当前请求路径
  data: T[];         // 资源数组
  has_more: boolean; // 是否还有更多数据
  total: number;     // 符合条件的总记录数
}
```

### 6. 删除响应

```typescript
// ✅ 必须返回 { id, object, deleted: true }，禁止 204 No Content
router.delete('/:id', async (req, res) => {
  const deleted = await deleteApp(req.params.id);
  if (!deleted) throw new GatewayError(404, 'not_found', `App ${req.params.id} not found`);
  res.json({ id: req.params.id, object: 'app', deleted: true });
});
```

### 7. Metadata 字段（可选扩展）

业务对象 **推荐** 支持 `metadata?: Record<string, string>`：最多 50 键，键名 ≤40 字符，值 ≤500 字符，**禁止存储** PII/凭据。metadata **不会自动传播**到关联对象。

---

## 三、嵌套资源与关联

### 8. 嵌套资源路由模式

| 关系                           | 推荐模式 | 示例                                         |
| ------------------------------ | -------- | -------------------------------------------- |
| 强归属（子资源离开父级无意义） | 嵌套     | `GET /admin/providers/:pid/models`           |
| 弱关联（子资源可独立存在）     | 平铺     | `GET /admin/provider-models?provider_id=xxx` |

> 现有路由使用平铺模式。新路由按上方推荐选择，旧路由无需强制迁移。

### 9. 关联字段表示

默认仅返回关联对象 ID（如 `provider_model_id`），前端按需请求。未来可选 `?expand=provider_model`。

---

## 四、完整 CRUD 端点模板

```typescript
import { Router } from 'express';
import type { Request, Response } from 'express';
import { GatewayError } from '@/utils';
import { handleAdminError } from './error';

const router = Router();

// GET /admin/resources — 列表
router.get('/', async (req: Request, res: Response) => {
  try {
    const { search, limit, offset } = req.query;
    const limitNum = typeof limit === 'string' ? Math.min(Number.parseInt(limit, 10), 100) : 10;
    const offsetNum = typeof offset === 'string' ? Math.max(Number.parseInt(offset, 10), 0) : 0;
    const { data, total, has_more } = await listResources({
      limit: limitNum, offset: offsetNum, search: typeof search === 'string' ? search : undefined,
    });
    res.json({
      object: 'list', url: '/admin/resources',
      data: data.map((r) => ({ object: 'resource' as const, ...r })), total, has_more,
    });
  } catch (error) { handleAdminError(error, res); }
});

// GET /admin/resources/:id — 详情
router.get('/:id', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const resource = await getResourceById(req.params.id);
    if (!resource) throw new GatewayError(404, 'not_found', `Resource ${req.params.id} not found`);
    res.json({ object: 'resource', ...resource });
  } catch (error) { handleAdminError(error, res); }
});

// POST /admin/resources — 创建
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name } = req.body as { name?: string };
    if (typeof name !== 'string' || name === '') {
      throw new GatewayError(400, 'invalid_request', 'Field "name" is required');
    }
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

// PATCH /admin/resources/:id — 局部更新
router.patch('/:id', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const resource = await updateResource(req.params.id, req.body);
    if (!resource) throw new GatewayError(404, 'not_found', `Resource ${req.params.id} not found`);
    res.json({ object: 'resource', ...resource });
  } catch (error) { handleAdminError(error, res); }
});

// DELETE /admin/resources/:id — 删除
router.delete('/:id', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const deleted = await deleteResource(req.params.id);
    if (!deleted) throw new GatewayError(404, 'not_found', `Resource ${req.params.id} not found`);
    res.json({ id: req.params.id, object: 'resource', deleted: true });
  } catch (error) { handleAdminError(error, res); }
});

export { router };
```
