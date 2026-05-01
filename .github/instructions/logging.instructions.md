---
description: '日志规范 — Winston 彩色日志、结构化记录、级别与脱敏'
applyTo: 'src/**/*.ts'
---

# 日志规范

## 概述
本文件定义 Linguist Gateway 的日志记录规范，基于 Winston 实现彩色、结构化的日志输出，确保调试效率和运维可观测性。

---

## 核心规则

### 1. `createLogger(name, color)` — 创建模块日志器

每个模块必须创建自己的日志器实例：

```typescript
import { createLogger, logColors } from '@/utils';

const logger = createLogger('ModuleName', logColors.bold + logColors.magenta);
```

**`logColors` 可用值**（可组合，用 `+` 连接）：

| 属性                                                                                  | 效果                     |
| ------------------------------------------------------------------------------------- | ------------------------ |
| `logColors.red` / `green` / `yellow` / `blue` / `magenta` / `cyan` / `white` / `gray` | 前景色                   |
| `logColors.bgRed`                                                                     | 背景色（醒目）           |
| `logColors.bold`                                                                      | 加粗                     |
| `logColors.dim`                                                                       | 暗淡                     |
| `logColors.reset`                                                                     | 重置（通常无需手动使用） |

**模块配色参考**（项目中实际使用）：

| 模块                        | 颜色组合         |
| --------------------------- | ---------------- |
| `Server`                    | `bold + blue`    |
| `Database`                  | `bold + magenta` |
| `ConfigManager`             | `bold + yellow`  |
| `Middleware` / `ApiKeyAuth` | `bold + gray`    |
| `Users` / `OpenAICompat`    | `bold + cyan`    |
| `Gemini`                    | `bold + blue`    |
| `Anthropic`                 | `bold + magenta` |
| `Error`                     | `bold + red`     |

### 2. 结构化日志格式

**DO** — 上下文数据作为第一个参数的对象传递：

```typescript
// ✅ 正确 — 结构化日志
logger.info({ requestId: ctx.id, ip: ctx.ip, format: ctx.userFormat }, 'Processing chat request');
logger.warn({ requestId: ctx.id, keyPrefix: rawKey.slice(0, 11) }, 'Invalid API key');
logger.debug({ query: text, duration, rows: result.rowCount }, 'Executed query');
```

**DON'T** — 不要在消息字符串中拼接上下文：

```typescript
// ❌ 错误 — 非结构化，难以搜索和聚合
logger.info(`[${requestId}] Processing request from ${ip}`);
```

### 3. 日志四级分类

| 级别    | 用途                                         | 触发频率 | 示例                                                               |
| ------- | -------------------------------------------- | -------- | ------------------------------------------------------------------ |
| `debug` | 调试细节：中间件执行、参数值、DB 查询详情    | 高频     | `logger.debug({ requestId, count }, 'executing middleware chain')` |
| `info`  | 关键流程节点：服务启动、连接建立、适配器注册 | 低频     | `logger.info({ maxConnections }, 'Database pool initialized')`     |
| `warn`  | 可预期的业务错误：GatewayError、认证失败     | 按需     | `logger.warn({ errorCode, statusCode }, err.message)`              |
| `error` | 未预期的异常：系统错误、崩溃                 | 低频     | `logger.error({ err, requestId }, 'Unexpected error')`             |

### 4. 错误日志传入 `{ err }`

传入 `{ err }` 时，Winston 自动提取 `err.stack`：

```typescript
// ✅ 正确 — 传递 err 对象，自动获取 stack trace
try {
  await riskyOperation();
} catch (err: unknown) {
  logger.error({ err, requestId: ctx.id }, 'Operation failed unexpectedly');
}
```

```typescript
// ❌ 错误 — 只传消息，丢失 stack trace
logger.error(`Operation failed: ${err.message}`);
```

### 5. 敏感信息脱敏

| 数据类型         | 脱敏规则                                    |
| ---------------- | ------------------------------------------- |
| API Key 原文     | 仅记录前 11 字符前缀：`rawKey.slice(0, 11)` |
| JWT Token        | **禁止记录**                                |
| 用户密码         | **禁止记录**                                |
| 数据库连接字符串 | 仅记录 host/port，不记录密码                |

```typescript
// ✅ 正确 — 脱敏
logger.warn({ keyPrefix: rawKey.slice(0, 11) }, 'Invalid API key');

// ❌ 错误 — 明文记录
logger.warn({ apiKey: rawKey }, 'Invalid API key');
```

### 6. 性能日志（可选埋点）

在关键 I/O 操作处记录耗时：

```typescript
const start = Date.now();
const result = await db.query('SELECT ...');
const duration = Date.now() - start;
logger.debug({ query: 'SELECT ...', duration, rows: result.rowCount }, 'Executed query');
```

---

## 常见陷阱

| 陷阱                                    | 正确做法                                            |
| --------------------------------------- | --------------------------------------------------- |
| 用 `console.log` 替代 logger            | 始终使用 Winston logger，确保统一格式和日志级别控制 |
| 日志消息中嵌入变量                      | 使用结构化对象传递上下文                            |
| 生产环境启用 debug 级别                 | 通过 `LOG_LEVEL` 环境变量控制（默认 `info`）        |
| 忘记在 `GatewayError` catch 中用 `warn` | GatewayError = 可预期 = `warn`；未知错误 = `error`  |

---

## 项目参考

- `src/utils/logger.ts` — `createLogger()` 和 `logColors` 实现
- `src/server.ts` — 请求级 debug 日志示例
- `src/db/client.ts` — DB 查询耗时日志示例
- `src/middleware/common/api-key-auth.ts` — warn 级别日志 + 脱敏示例
- `src/model/http/users/error-handler.ts` — err 对象传递示例
