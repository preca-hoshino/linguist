---
description: '权限模型规范 — RBAC 权限校验、赋权天花板、canManageUser、自保护、速率限制'
applyTo: 'src/admin/**/*.ts, src/types/common/permissions.ts, src/db/users/**/*.ts, src/db/sql/migrations/*permissions*.sql'
---

# 权限模型规范（后端）

基于 Scope 的 RBAC 权限系统。所有登录用户默认拥有 `view` 权限，`edit` 需显式授予。

---

## 1. 权限定义

```typescript
// src/types/common/permissions.ts
export const PERMISSION_MODULES = ['models', 'mcp', 'apps', 'users', 'settings'] as const;
export type PermissionModule = (typeof PERMISSION_MODULES)[number];
export type PermissionLevel = 'view' | 'edit';
```

**5 模块 × 2 级别**，`edit` 隐含 `view`。

| 模块       | view                          | edit                 |
| ---------- | ----------------------------- | -------------------- |
| `models`   | 提供商/模型/日志/统计只读     | CRUD + Copilot OAuth |
| `mcp`      | MCP 提供商/虚拟/日志/统计只读 | CRUD                 |
| `apps`     | 应用列表只读                  | CRUD + Key 轮换      |
| `users`    | 用户列表只读                  | CRUD + 权限分配      |
| `settings` | 预留（个人设置不需权限）      | 未来系统级配置       |

---

## 2. 权限校验中间件

```typescript
// src/admin/permission.ts
router.get('/', requirePermission('models', 'view'), handler);   // 只读
router.post('/', requirePermission('models', 'edit'), handler);   // 写操作
router.use(requirePermission('models', 'edit'));                  // 整个路由组
```

**规则**：所有业务路由必须使用 `requirePermission`，公开端点（login、health、avatar）除外。

---

## 3. 权限天花板（赋权校验）

**核心规则**：只能授予自己已拥有的权限。

```typescript
// 创建/修改用户时
for (const mod of PERMISSION_MODULES) {
  if (!hasPermission(operatorPerms, mod, targetPerms[mod])) {
    throw new GatewayError(403, 'insufficient_permissions',
      `Cannot grant ${mod}:${targetPerms[mod]} — your level is ${operatorPerms[mod]}`);
  }
}
```

**3 个校验点**：
1. `POST /users` — 创建用户时
2. `PATCH /users/:id` — 修改他人权限时
3. `DELETE /users/:id` — 删除用户时（`canManageUser`）

---

## 4. 自保护

```typescript
// 禁止修改自己的权限
if (requestUserId === targetUserId) {
  throw new GatewayError(400, 'invalid_request', 'Cannot modify your own permissions');
}

// 禁止删除自己
if (requestUserId === targetUserId) {
  throw new GatewayError(400, 'invalid_request', 'Cannot delete your own account');
}
```

---

## 5. 管理链（canManageUser）

```typescript
// 操作者的权限必须完全覆盖目标用户的权限
export function canManageUser(operator: UserPermissions, target: UserPermissions): boolean {
  return PERMISSION_MODULES.every((m) => LEVEL_VALUE[operator[m]] >= LEVEL_VALUE[target[m]]);
}
```

**用于**：PATCH（编辑他人信息）、DELETE（删除用户）。低权限用户不能管理高权限用户。

---

## 6. 数据库

```sql
-- 权限字段（JSONB）
ALTER TABLE users ADD COLUMN permissions JSONB NOT NULL
  DEFAULT '{"models":"view","mcp":"view","apps":"view","users":"view","settings":"view"}'::jsonb;
```

**DEFAULT 为全 `view`**，新用户默认只读。管理员需显式传入 `edit` 权限。

---

## 7. 登录速率限制

```typescript
// src/admin/login.ts
const loginRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: { code: 'rate_limited', message: 'Too many login attempts' } },
});
loginRouter.post('/login', loginRateLimiter, handler);
```

---

## 禁止事项

- ❌ 不要在 `requirePermission` 之外自行检查 `res.locals.userPermissions`
- ❌ 不要在创建/修改用户时跳过权限天花板校验
- ❌ 不要引入 `is_owner` 或任何特权标志 — 所有用户权限平等，仅通过 scopes/permissions 区分
- ❌ 不要在公开路由（login、avatar）上使用 `requirePermission`
