---
description: '数据库规范 — 参数化查询、事务、迁移、查询组织模式'
applyTo: 'src/db/**/*.ts, src/db/**/*.sql'
---

# 数据库规范

使用原始 SQL + `pg` 驱动：`db.query()` 参数化查询、`withTransaction()` 事务、幂等 SQL 迁移。

---

## 1. 参数化查询 — `db.query<T>(sql, params[])`

**必须**用 `$1, $2` 占位符，**严禁** SQL 字符串拼接：

```typescript
import { db } from '@/db/client';

// ✅ 正确 — 参数化
const result = await db.query<User>('SELECT id, name FROM users WHERE id = $1', [userId]);

// ✅ INSERT 带 RETURNING
const inserted = await db.query<{ id: string }>(
  'INSERT INTO apps (name, api_key) VALUES ($1, $2) RETURNING id', [name, apiKey]
);

// ❌ 禁止字符串拼接 — SQL 注入漏洞
const result = await db.query(`SELECT * FROM users WHERE id = '${userId}'`);
```

## 2. `SAFE_COLUMNS` — 安全列名常量

查询用户表 **禁止 `SELECT *`**，必须用预定义的安全列名常量避免泄露 `password_hash`：

```typescript
import { SAFE_COLUMNS } from '@/db/users/constants';

const result = await db.query<User>(`SELECT ${SAFE_COLUMNS} FROM users WHERE id = $1`, [userId]);
```

## 3. `withTransaction()` — 事务包装

签名：`withTransaction<T>(fn: (executor: QueryExecutor) => Promise<T>): Promise<T>`，自动 `BEGIN → COMMIT → ROLLBACK`：

```typescript
import { withTransaction } from '@/db/client';

const result = await withTransaction(async (executor) => {
  const inserted = await executor.query<{ id: string }>(
    'INSERT INTO apps (name) VALUES ($1) RETURNING id', [name]
  );
  return { appId: inserted.rows[0].id };
});

// ❌ 禁止手动 BEGIN/COMMIT/ROLLBACK — 容易遗漏回滚
```

## 4. 迁移文件规范

位于 `src/db/migrations/`，命名 `NN_description.sql`。**必须幂等**——可安全重复执行：

```sql
CREATE TABLE IF NOT EXISTS apps (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL);
ALTER TABLE apps ADD COLUMN IF NOT EXISTS description TEXT;
CREATE INDEX IF NOT EXISTS idx_apps_api_key ON apps(api_key);
```

执行：`npm run db`。通过 `migration_history` 表跟踪已执行迁移。

## 5. 查询函数组织模式

每个领域在 `src/db/<domain>/index.ts` 导出类型化 CRUD 函数：

| 命名                   | 返回        | 用途                      |
| ---------------------- | ----------- | ------------------------- |
| `get<Entity>By<Key>()` | `T \| null` | 单条查询                  |
| `list<Entities>()`     | `T[]`       | 列表查询                  |
| `create<Entity>()`     | `T`         | 创建                      |
| `update<Entity>()`     | `T`         | 更新                      |
| `delete<Entity>()`     | `void`      | 软删除（设 `deleted_at`） |

所有软删除表的查询 **必须** 加 `WHERE deleted_at IS NULL`。

## 6. 数据库连接池

```bash
DATABASE_URL=postgresql://user:pass@localhost:5432/linguist
DB_POOL_MAX=20
```

```typescript
// 优雅关闭
import { closePool } from '@/db/client';
process.on('SIGTERM', async () => { await closePool(); process.exit(0); });
```
