---
description: '数据库规范 — 参数化查询、事务、迁移、查询组织模式'
applyTo: 'src/db/**/*.ts, src/db/**/*.sql'
---

# 数据库规范

## 概述
本文件定义 Linguist Gateway 的数据库操作规范：使用原始 SQL + `pg` 驱动，通过 `db.query()` 参数化查询、`withTransaction()` 事务包装和幂等 SQL 迁移管理数据层。

---

## 核心规则

### 1. 参数化查询 — `db.query<T>(sql, params[])`

**必须**使用参数化占位符 `$1, $2, ...`，**严禁拼接 SQL 字符串**：

```typescript
import { db } from '@/db/client';

// ✅ 正确 — 参数化查询
const result = await db.query<User>(
  'SELECT id, name, email FROM users WHERE id = $1',
  [userId]
);

// ✅ 正确 — 多个参数
const result = await db.query<AppInfo>(
  'SELECT id, name, is_active FROM apps WHERE api_key = $1 AND deleted_at IS NULL',
  [rawKey]
);

// ✅ 正确 — INSERT 带 RETURNING
const inserted = await db.query<{ id: string }>(
  'INSERT INTO apps (name, api_key) VALUES ($1, $2) RETURNING id',
  [name, apiKey]
);
```

```typescript
// ❌ 错误 — SQL 拼接，SQL 注入漏洞
const result = await db.query(`SELECT * FROM users WHERE id = '${userId}'`);
// ❌ 错误 — 模板字符串拼接参数
const result = await db.query(`SELECT * FROM users WHERE id = ${userId}`);
```

### 2. `SAFE_COLUMNS` — 安全列名常量

查询用户表 **禁止 `SELECT *`**，必须使用预定义的安全列名常量，避免泄露 `password_hash` 等敏感字段：

```typescript
// ✅ 正确 — 使用 SAFE_COLUMNS
import { SAFE_COLUMNS } from '@/db/users/constants';

const result = await db.query<User>(
  `SELECT ${SAFE_COLUMNS} FROM users WHERE id = $1`,
  [userId]
);
```

```typescript
// ❌ 错误 — SELECT * 暴露了 password_hash
const result = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
```

### 3. `withTransaction()` — 事务包装

签名：`withTransaction<T>(fn: (executor: QueryExecutor) => Promise<T>): Promise<T>`

自动处理 `BEGIN → COMMIT → ROLLBACK`：

```typescript
import { withTransaction } from '@/db/client';

// ✅ 正确 — 原子操作
await withTransaction(async (executor) => {
  const user = await executor.query<User>(
    'INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id',
    [name, email]
  );
  await executor.query(
    'INSERT INTO billing_accounts (user_id, balance) VALUES ($1, $2)',
    [user.rows[0].id, 0]
  );
});

// ✅ 正确 — 带返回值的事务
const result = await withTransaction(async (executor) => {
  const inserted = await executor.query<{ id: string }>(
    'INSERT INTO apps (name) VALUES ($1) RETURNING id',
    [name]
  );
  return { appId: inserted.rows[0].id };
});
```

```typescript
// ❌ 错误 — 手动管理事务（容易遗漏 ROLLBACK）
const client = await pool.connect();
await client.query('BEGIN');
// ... 如果中间出错，不会 ROLLBACK
await client.query('COMMIT');
client.release();
```

### 4. 迁移文件规范

迁移文件位于 `src/db/migrations/` 和 `src/db/sql/migrations/`。

**命名规范**：`NN_description.sql`（NN 为递增序号）

```
src/db/migrations/
  01_initial_schema.sql
  02_add_api_key_index.sql
  03_add_mcp_tables.sql
  ...
```

**幂等性要求** — 每个迁移必须可以安全重复执行：

```sql
-- ✅ 正确 — 使用 IF NOT EXISTS / IF EXISTS
CREATE TABLE IF NOT EXISTS apps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL
);

ALTER TABLE apps ADD COLUMN IF NOT EXISTS description TEXT;

CREATE INDEX IF NOT EXISTS idx_apps_api_key ON apps(api_key);
```

**迁移执行**：
```bash
npm run db    # 运行所有待执行的迁移
```

迁移通过 `migration_history` 表跟踪已执行的迁移，保证只执行一次。

### 5. 查询函数组织模式

每个领域模块在 `src/db/<domain>/index.ts` 导出类型化的 CRUD 函数：

```typescript
// src/db/users/index.ts
import { db } from '@/db/client';
import type { User } from '@/types';

export async function getUserById(userId: string): Promise<User | null> {
  const result = await db.query<User>(
    'SELECT id, name, email FROM users WHERE id = $1 AND deleted_at IS NULL',
    [userId]
  );
  return result.rows[0] ?? null;
}

export async function listUsers(limit: number, offset: number): Promise<User[]> {
  const result = await db.query<User>(
    'SELECT id, name, email FROM users WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT $1 OFFSET $2',
    [limit, offset]
  );
  return result.rows;
}
```

**查询函数命名惯例**：
- 单条查询：`get<Entity>By<Key>()` → 返回 `T | null`
- 列表查询：`list<Entities>()` → 返回 `T[]`
- 创建：`create<Entity>()` → 返回创建的实体
- 更新：`update<Entity>()` → 返回更新后的实体
- 软删除：`delete<Entity>()` → 设置 `deleted_at`

### 6. 数据库连接池

环境变量配置：

```bash
DATABASE_URL=postgresql://user:pass@localhost:5432/linguist
DB_POOL_MAX=20         # 最大连接数（默认 20）
```

```typescript
// 优雅关闭
import { closePool } from '@/db/client';

process.on('SIGTERM', async () => {
  await closePool();
  process.exit(0);
});
```

---

## 常见陷阱

| 陷阱                            | 正确做法                                    |
| ------------------------------- | ------------------------------------------- |
| `SELECT *` 泄露敏感字段         | 使用 `SAFE_COLUMNS` 或显式列出列名          |
| SQL 字符串拼接                  | 使用 `$1, $2` 参数化占位符                  |
| 非幂等迁移                      | 所有 DDL 加上 `IF NOT EXISTS` / `IF EXISTS` |
| 手动管理事务                    | 使用 `withTransaction()`                    |
| 忘记 `WHERE deleted_at IS NULL` | 软删除表的所有查询都需过滤已删除记录        |
| 直接 new Pool 而非 getPool      | 使用单例 `getPool()` 避免多连接池           |

---

## 项目参考

- `src/db/client.ts` — `db.query()`、`withTransaction()`、`getPool()`、`closePool()` 实现
- `src/db/apps/index.ts` — 领域查询函数组织模式示例
- `src/db/users/index.ts` — CRUD 函数命名范例
- `src/db/migrations/` — 迁移文件存放位置
- `src/db/sql/` — Schema 定义和补丁迁移
