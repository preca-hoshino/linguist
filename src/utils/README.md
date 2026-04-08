# src/utils — 公用工具模块

> 项目总览：参见 [README.md](../README.md)
> 
> 核心依赖：[`src/types/README.md`](../types/README.md)（GatewayError 类型）

## 简介

提供整个项目通用的工具函数：错误处理、结构化日志、动态 SQL 构建。所有模块均通过 `import { ... } from '../utils'` 一次性导入。

## 目录结构

```
utils/
├── errors.ts           # GatewayError 类
├── logger.ts           # createLogger(module) — winston 日志工厂（无默认实例导出，各模块自行创建）
├── query-builder.ts    # buildUpdateSet + buildBatchInsert — 动态 SQL 构建
├── json.ts             # JSON 解析工具
├── media.ts            # 媒体类型处理
├── sse.ts              # SSE 流式传输工具
├── constants.ts        # 常量定义
├── hash.ts             # 密码哈希工具（scrypt）
├── jwt.ts              # JWT 工具
├── uuid.ts             # UUID v4/v5 生成器
├── tool-id.ts          # 工具调用 ID → UUID v5 规范化
├── rate-limiter.ts     # 内存限流器
└── index.ts            # 统一再导出
```

> **注意**：提供商错误映射（`mapProviderError`）和提供商响应解析（`parseProviderResponse`）已迁移至 `src/providers/` 模块，参见 [`src/providers/README.md`](../providers/README.md)。
> 用户格式错误响应（`handleError`）已迁移至 `src/users/error-formatting/` 模块，参见 [`src/users/README.md`](../users/README.md)。

## GatewayError

```typescript
class GatewayError extends Error {
  constructor(
    public statusCode: number,        // HTTP 状态码（400、404、500 等）
    public errorCode: string,         // 机器可读错误标识（如 'model_not_found'、'rate_limit_exceeded'）
    message: string,                  // 人类可读错误描述
    providerDetail?: ProviderErrorDetail,  // 提供商原始错误详情（可选）
  ) {}
}
```

可选的 `providerDetail` 字段用于保留提供商返回的原始错误信息（HTTP 状态码、错误码、原始响应体），供审计和 UI 展示使用。

## createLogger(module)

基于 winston 的模块日志工厂，每个模块传入模块名以区分日志来源：

```typescript
const logger = createLogger('Router');
logger.info({ requestId: ctx.id }, 'Route resolved');
```

日志级别由 `LOG_LEVEL` 环境变量控制（默认 `info`）。

## hashPassword / verifyPassword

基于 Node.js 内置 `crypto.scryptSync` 的密码哈希工具，输出格式 `scrypt:<salt_hex>:<hash_hex>`：

```typescript
const hash = hashPassword('myPassword');
const valid = verifyPassword('myPassword', hash);
```

## jwt.sign / jwt.verify

JWT 签发与验证工具（使用 `jose` 库）：

```typescript
const token = jwt.sign({ sub: 'user123' }, secret, { expiresIn: '1h' });
const payload = jwt.verify(token, secret);
```

## uuid.v4 / uuid.v5

UUID 生成工具：

```typescript
import { v4, v5, DNS_NAMESPACE } from '../utils';

// 随机 UUID v4
const id = v4();

// 基于名称的 UUID v5（确定性）
const uuid = v5('tool_call_id', DNS_NAMESPACE);
```

## tool-id.ts

将工具调用 ID 确定性映射为 UUID v5，确保消息中所有相关 ID 保持一致：

```typescript
const normalized = normalizeToolIds(messages);
```

## rateLimiter

基于内存的滑动窗口限流器：

```typescript
const limiter = rateLimiter({ windowMs: 60000, max: 100 });
const result = await limiter.consume('user_123');
```

## createCachedLoggerFactory(specs, defaultPrefix, defaultColor)

创建一个带缓存的 Logger 工厂函数，通过预注册映射表和默认回退避免重复创建 Logger 实例。适用于按运行时 key 动态获取 Logger 的场景（如用户格式、提供商类型）：

```typescript
const getFormatLogger = createCachedLoggerFactory(
  { openaicompat: { prefix: 'API:OpenAICompat', color: logColors.white },
    gemini:       { prefix: 'API:Gemini',       color: logColors.white } },
  'API',
  logColors.white,
);
// getFormatLogger('openaicompat') → 缓存的 Logger 实例
// getFormatLogger('unknown')      → 自动创建 'API:unknown' Logger 并缓存
```

## buildUpdateSet / buildBatchInsert

```typescript
// 动态 UPDATE SET
const { setClause, values, nextIndex } = buildUpdateSet({
  name: 'DeepSeek',
  kind: undefined,  // undefined 能量被跳过
  is_active: true,
});
// setClause: "name = $1, is_active = $2, updated_at = $3"

// 批量 INSERT 占位符
const { placeholders, values } = buildBatchInsert(
  [{ a: 1, b: 2 }, { a: 3, b: 4 }],
  ['a', 'b']
);
// placeholders: "($1, $2), ($3, $4)"
```

## 新增 / 重构 / 删除向导

### 新增工具函数

1. 将新函数添加到现有对应文件（按职能归类），或新建`.ts`文件
2. 如新建文件，在 `index.ts` 中添加再导出语句
3. 新工具不应依赖项目内部模块（`types/`、`config/` 等），保持工具层的单向依赖

### 重构

- **换日志库**：只需修改 `logger.ts`，其他模块的调用方式不变
- **扩展错误格式**：在 `errors.ts` 的 `handleError` 中添加新的 `format` 分支，并同步更新对应的用户适配器

### 删除工具函数

1. 从对应文件中删除函数
2. 在 `index.ts` 中移除再导出
3. 运行 `npm run type-check` 找出所有引用并一并删除
