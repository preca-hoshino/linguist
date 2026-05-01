---
description: '代码风格规范 — 导入、命名、类型声明、模块系统'
applyTo: 'src/**/*.ts, src/**/*.js'
---

# 代码风格规范

## 概述
本文件定义 Linguist Gateway 所有 TypeScript/JavaScript 代码的统一风格约束，覆盖导入路径、import 排序、命名规范、类型声明和 CommonJS 注意事项。

---

## 核心规则

### 1. 绝对路径导入 `@/*`

**DO** — 始终使用 `@/*` 绝对路径：

```typescript
// ✅ 正确
import { GatewayError } from '@/utils/errors';
import { db } from '@/db/client';
import type { ModelHttpContext } from '@/types';
```

**DON'T** — 禁止使用相对路径 `../../`：

```typescript
// ❌ 错误 — 相对路径跨层级脆弱
import { GatewayError } from '../../utils/errors';
```

### 2. Import 分组与排序

所有 import 按以下层级分组，组间空一行：

| 分组          | 内容     | 示例                       |
| ------------- | -------- | -------------------------- |
| 1. 外部依赖   | npm 包   | `express`, `pg`, `winston` |
| 2. Config     | 配置模块 | `@/config/manager`         |
| 3. DB         | 数据库层 | `@/db/client`              |
| 4. Middleware | 中间件   | `@/middleware`             |
| 5. Model      | 核心模型 | `@/model`                  |
| 6. Types      | 类型定义 | `@/types`                  |
| 7. Utils      | 工具函数 | `@/utils`                  |

**DO** — 正确分组示例：

```typescript
import type { Request, Response } from 'express';
import express from 'express';

import { ConfigManager } from '@/config/manager';

import { db } from '@/db/client';

import { apiKeyAuth } from '@/middleware/common';

import { routeModel } from '@/model/http/router';

import type { ModelHttpContext } from '@/types';
import type { ProviderConfig } from '@/types/provider';

import { createLogger, GatewayError, logColors } from '@/utils';
```

**DON'T** — 分组混乱或缺少空行：

```typescript
// ❌ 错误 — 无分组、无空行
import express from 'express';
import { db } from '@/db/client';
import { GatewayError } from '@/utils/errors';
import { ConfigManager } from '@/config/manager';
```

### 3. 命名规范

| 目标                 | 规范               | 示例                                  |
| -------------------- | ------------------ | ------------------------------------- |
| 文件名               | `kebab-case`       | `api-key-auth.ts`, `query-builder.ts` |
| 目录名               | `kebab-case`       | `request-logs/`, `mcp-providers/`     |
| 函数 / 变量          | `camelCase`        | `getUserById()`, `apiKey`             |
| 类 / 接口 / 类型别名 | `PascalCase`       | `GatewayError`, `ModelHttpContext`    |
| 环境常量 / 魔法数字  | `UPPER_SNAKE_CASE` | `DEFAULT_EXPIRES_IN`, `MAX_RETRIES`   |
| 私有模块级变量       | 无前缀 `_`         | `let pool: Pool \| null = null`       |

### 4. `interface` vs `type`

| 使用 `interface`   | 使用 `type`         |
| ------------------ | ------------------- |
| 数据结构定义       | 联合类型            |
| 可被扩展 (extends) | 交叉类型            |
| 对象形状           | 类型别名 / 函数签名 |

```typescript
// ✅ 数据结构 → interface
export interface ModelHttpContext {
  id: string;
  ip: string;
  route?: { model: string; providerId: string };
}

// ✅ 联合/别名 → type
export type Middleware = (ctx: ModelHttpContext) => void | Promise<void>;
export type ApiResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: ApiErrorBody };
```

### 5. 禁止 `any` 的替代方案

```typescript
// ❌ 禁止
function process(data: any): any { ... }

// ✅ 未知类型用 unknown
function process(data: unknown): Record<string, unknown> { ... }

// ✅ 泛型约束
function query<T extends Record<string, unknown>>(sql: string): Promise<T> { ... }

// ✅ 类型守卫
if (typeof data === 'object' && data !== null && 'id' in data) { ... }
```

### 6. CommonJS 模块系统

本项目使用 `"type": "commonjs"`。

```typescript
// ✅ 导入（TypeScript 编译为 require）
import { db } from '@/db/client';
import type { ModelHttpContext } from '@/types';

// ✅ 导出（编译为 module.exports / exports.xxx）
export function createLogger(name: string): Logger { ... }
export { GatewayError };
```

**注意事项**：
- `import type` 编译后不生成 `require` 语句，仅用于类型检查
- 不要在运行时使用 ESM 独占语法（`import.meta`、顶层 `await`）
- 动态导入需用 `await import(...)`（异步）

---

## 常见陷阱

| 陷阱                               | 说明                                                                                                              |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `import type` 与运行时 import 混写 | `import type` 仅类型；`import` 生成运行时代码。两者可在同一来源时合并：`import { foo, type Bar } from '@/module'` |
| 循环依赖                           | 避免模块间相互引用。若必须，将共同类型提取到 `@/types/`，使用 `import type` 打破运行时循环                        |
| `../../` 地狱                      | 深层目录文件用相对路径会产生 `../../../../`，重构时极易断裂                                                       |

---

## 项目参考

- `src/server.ts` — 典型 import 分组示例
- `src/types/context.ts` — `interface` 定义数据结构的标准范例
- `src/middleware/index.ts` — `type` 别名 + 导出模式
- `.eslint.config.mjs` — 与 ESLint 规则一致的约束
