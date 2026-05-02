---
description: '日志规范 — Winston 结构化日志、级别分类、敏感信息脱敏'
applyTo: 'src/**/*.ts'
---

# 日志规范

基于 Winston 的结构化日志策略：模块级 logger、对象传参、四级分类、敏感脱敏。

---

## 1. `createLogger(name, color)` — 创建模块日志器

```typescript
import { createLogger, logColors } from '@/utils';

const logger = createLogger('ModuleName', logColors.bold + logColors.magenta);
```

`logColors` 可组合前景色（`red/green/yellow/blue/magenta/cyan/white/gray`）、`bold`、`dim`、`bgRed`。

## 2. 结构化日志 — 对象传参

**必须**将上下文数据作为第一个参数的对象传递，禁止在消息字符串中拼接：

```typescript
// ✅ 正确 — 结构化
logger.info({ requestId: ctx.id, ip: ctx.ip }, 'Processing chat request');
logger.warn({ keyPrefix: rawKey.slice(0, 11) }, 'Invalid API key');

// ❌ 错误 — 字符串拼接
logger.info(`[${requestId}] Processing request from ${ip}`);
```

## 3. 日志四级分类

| 级别    | 用途                                     | 示例                                                   |
| ------- | ---------------------------------------- | ------------------------------------------------------ |
| `debug` | 调试细节（中间件执行、DB 查询）          | `logger.debug({ requestId, duration }, 'Query done')`  |
| `info`  | 关键流程节点（服务启动、连接建立）       | `logger.info({ port }, 'Server listening')`            |
| `warn`  | 可预期业务错误（GatewayError、认证失败） | `logger.warn({ errorCode }, err.message)`              |
| `error` | 未预期异常（系统错误、崩溃）             | `logger.error({ err, requestId }, 'Unexpected error')` |

## 4. 错误日志传入 `{ err }`

传入 `{ err }` 时 Winston 自动提取 `err.stack`：

```typescript
// ✅ 正确 — 传递 err 对象
catch (err: unknown) {
  logger.error({ err, requestId: ctx.id }, 'Operation failed unexpectedly');
}

// ❌ 禁止只传消息字符串 — 丢失 stack trace
```

## 5. 敏感信息脱敏

| 数据类型             | 脱敏规则                                |
| -------------------- | --------------------------------------- |
| API Key 原文         | 仅记录前 11 字符：`rawKey.slice(0, 11)` |
| JWT Token / 用户密码 | **禁止记录**                            |
| 数据库连接字符串     | 仅记录 host/port                        |

## 6. 性能日志（可选埋点）

```typescript
const start = Date.now();
const result = await db.query('SELECT ...');
logger.debug({ query: 'SELECT ...', duration: Date.now() - start, rows: result.rowCount });
```
