---
description: '管理 API 参数校验 — 查询参数、请求体验证、幂等性、状态码'
applyTo: 'src/admin/**/*.ts'
---

# 管理 API 参数校验

---

## 一、查询参数规范

| 参数        | 类型              | 用途                       | 示例               |
| ----------- | ----------------- | -------------------------- | ------------------ |
| `search`    | `string`          | 模糊搜索                   | `?search=openai`   |
| `limit`     | `integer`         | 每页条数（1–100，默认 10） | `?limit=20`        |
| `offset`    | `integer`         | 分页偏移（≥0，默认 0）     | `?offset=40`       |
| `is_active` | `boolean`         | 按启用状态过滤             | `?is_active=true`  |
| `sort`      | `string`          | 排序字段                   | `?sort=created_at` |
| `order`     | `'asc' \| 'desc'` | 排序方向                   | `?order=desc`      |
| `<field>`   | `string`          | 按其他字段精确过滤         | `?kind=openai`     |

**必须**做类型转换 + 边界限制 + 白名单校验：

```typescript
router.get('/', async (req, res) => {
  const { search, limit, offset, is_active, kind, sort, order } = req.query;

  // 分页参数：类型转换 + 边界限制
  const limitNum = typeof limit === 'string'
    ? Math.min(Math.max(Number.parseInt(limit, 10), 1), 100) : 10;
  const offsetNum = typeof offset === 'string'
    ? Math.max(Number.parseInt(offset, 10), 0) : 0;

  // 布尔参数
  const isActiveBool = typeof is_active === 'string'
    ? is_active.toLowerCase() === 'true' : undefined;

  // 枚举参数 — 白名单校验
  const validKinds = new Set(['openai', 'anthropic', 'gemini']);
  const kindStr = typeof kind === 'string' && validKinds.has(kind) ? kind : undefined;

  // 排序参数 — 白名单校验
  const validSortFields = new Set(['created_at', 'updated_at', 'name']);
  const sortField = typeof sort === 'string' && validSortFields.has(sort) ? sort : undefined;
  const sortOrder = order === 'desc' ? 'DESC' : 'ASC';

  const result = await listProviders({
    limit: limitNum, offset: offsetNum,
    search: typeof search === 'string' ? search : undefined,
    is_active: isActiveBool, kind: kindStr, sort: sortField, order: sortOrder,
  });
  // ...
});

// ❌ 禁止直接透传 req.query — SQL 注入风险
```

---

## 二、请求体验证

所有 `POST` / `PATCH` 路由 **必须** 在函数开头逐字段验证：

```typescript
router.post('/', async (req, res) => {
  const body = req.body as { name?: string; kind?: string; base_url?: string };

  // 1. 必填字段 — 明确的错误消息
  if (typeof body.name !== 'string' || body.name === '') {
    throw new GatewayError(400, 'invalid_request', 'Field "name" is required and must be a non-empty string');
  }

  // 2. 格式校验
  if (body.base_url !== undefined && typeof body.base_url !== 'string') {
    throw new GatewayError(400, 'invalid_request', 'Field "base_url" must be a string');
  }

  // 3. 枚举值校验 — 白名单
  const validKinds = new Set(['openai', 'anthropic', 'gemini']);
  if (!validKinds.has(body.kind!)) {
    throw new GatewayError(400, 'invalid_request', `Unsupported kind: ${body.kind}`);
  }

  const resource = await createResource(body);
  res.status(201).json({ object: 'resource', ...resource });
});

// ❌ 禁止不可操作的错误消息："Something went wrong"、"Invalid input"
```

> 推荐未来引入 [zod](https://zod.dev/) 做声明式校验，此时校验失败用 `422` 状态码。

---

## 三、幂等性

所有 `POST` 请求自动受 `idempotencyMiddleware`（`src/admin/idempotency.ts`）保护。

**客户端要求**：携带 `Idempotency-Key: <resource>_<uuid>` 请求头。

**服务端行为**：
1. 首遇 Key → 正常执行业务逻辑，响应缓存到 `idempotency_keys` 表
2. 再次命中 → 直接返回缓存结果，**不重复执行业务逻辑**
3. 仅对 `POST` 生效（`GET`/`PATCH`/`DELETE` 天然幂等）

```typescript
// 安全重试模式
const key = `app_${crypto.randomUUID()}`;
const res = await fetch('/admin/apps', {
  method: 'POST',
  headers: { 'Idempotency-Key': key, 'Authorization': `Bearer ${token}` },
  body: JSON.stringify(body),
});
```

---

## 四、HTTP 状态码速查

| 状态码 | 含义       | 使用场景                                                     |
| ------ | ---------- | ------------------------------------------------------------ |
| `200`  | 成功       | GET / PATCH / DELETE 成功                                    |
| `201`  | 已创建     | POST 创建成功                                                |
| `400`  | 请求错误   | 参数缺失、格式错误、数值越界                                 |
| `401`  | 未认证     | 缺少或无效的 JWT Token                                       |
| `403`  | 无权限     | Token 有效但权限不足                                         |
| `404`  | 未找到     | 资源 ID 不存在                                               |
| `409`  | 冲突       | 唯一键重复                                                   |
| `422`  | 校验失败   | 请求体字段级校验失败（引入 zod 后使用）                      |
| `500`  | 服务端错误 | 未预期内部异常 — 视作「不确定状态」，调用方配合幂等 Key 重试 |
