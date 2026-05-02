---
description: '代码风格规范 — 导入、命名、类型声明、模块系统'
applyTo: 'src/**/*.ts, src/**/*.js'
---

# 代码风格规范

---

## 1. 绝对路径导入 `@/*`

```typescript
// ✅ 始终用 @/* 绝对路径
import { GatewayError } from '@/utils/errors';
import { db } from '@/db/client';
import type { ModelHttpContext } from '@/types';

// ❌ 禁止跨层级相对路径 ../../utils/errors
```

## 2. Import 分组与排序

按以下层级分组，组间空一行：外部依赖 → Config → DB → Middleware → Model → Types → Utils。

```typescript
import type { Request, Response } from 'express';
import express from 'express';

import { ConfigManager } from '@/config/manager';

import { db } from '@/db/client';

import { apiKeyAuth } from '@/middleware/common';

import { routeModel } from '@/model/http/router';

import type { ModelHttpContext } from '@/types';

import { createLogger, GatewayError, logColors } from '@/utils';
```

## 3. 命名规范

| 目标                 | 规范               | 示例                                |
| -------------------- | ------------------ | ----------------------------------- |
| 文件名 / 目录名      | `kebab-case`       | `api-key-auth.ts`, `request-logs/`  |
| 函数 / 变量          | `camelCase`        | `getUserById()`, `apiKey`           |
| 类 / 接口 / 类型别名 | `PascalCase`       | `GatewayError`, `ModelHttpContext`  |
| 环境常量             | `UPPER_SNAKE_CASE` | `DEFAULT_EXPIRES_IN`, `MAX_RETRIES` |
| 私有模块级变量       | 无前缀 `_`         | `let pool: Pool \| null = null`     |

## 4. `interface` vs `type`

| `interface`          | `type`                       |
| -------------------- | ---------------------------- |
| 数据结构、可扩展对象 | 联合类型、交叉类型、函数签名 |

```typescript
// ✅ 数据结构 → interface
export interface ModelHttpContext { id: string; ip: string; }

// ✅ 联合/别名 → type
export type Middleware = (ctx: ModelHttpContext) => void | Promise<void>;
```

## 5. 禁止 `any`

```typescript
// ❌ 禁止 any
function process(data: any): any { ... }

// ✅ unknown + 类型守卫
function process(data: unknown): Record<string, unknown> { ... }

// ✅ 泛型约束
function query<T extends Record<string, unknown>>(sql: string): Promise<T> { ... }
```

## 6. CommonJS 模块系统

项目使用 `"type": "commonjs"`。`import type` 编译后不生成 `require`；禁止使用 ESM 独占语法（`import.meta`、顶层 `await`）。循环依赖时将共同类型提取到 `@/types/` 并用 `import type` 打破运行时循环。
