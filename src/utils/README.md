# src/utils — 公用工具模块

> 项目总览：参见 [README.md](../README.md)
> 
> 核心依赖：[`src/types/README.md`](../types/README.md)（GatewayError 类型）

## 简介

提供整个项目通用的工具函数：错误处理、结构化日志、动态 SQL 构建。所有模块均通过 `import { ... } from '../utils'` 一次性导入。

## 目录结构

```
utils/
├── crypto/             # 加密工具子模块
│   ├── index.ts        #   barrel 再导出
│   ├── hash.ts         #   密码哈希工具（scrypt）
│   ├── jwt.ts          #   JWT HS256 签发与验证
│   └── uuid.ts         #   UUID v4/v5 生成器
├── http/               # HTTP 协议工具子模块
│   ├── index.ts        #   barrel 再导出
│   ├── sse.ts          #   SSE 流式解析器
│   └── response-headers.ts  # 响应头注入（X-Request-Id 等）
├── sql/                # SQL 构建工具子模块
│   ├── index.ts        #   barrel 再导出
│   └── query-builder.ts    # buildUpdateSet / buildBatchInsert / buildInClause
├── errors.ts           # GatewayError 类
├── logger.ts           # createLogger(module) — winston 日志工厂
├── rate-limiter.ts     # 内存限流器（滑动窗口）
├── transform.ts        # 数据转换工具（安全 JSON 解析 + MIME 类型推断，合并自原 json.ts + media.ts）
├── math.ts             # 数值计算工具（roundRate / safeRate / roundOrNull，从 db/stats/helpers 提取）
├── headers.ts          # 请求头脱敏与格式转换（sanitizeHeaders / expressHeadersToRecord，从 app/helpers 提取）
├── tool-id.ts          # 工具调用 ID → UUID v5 规范化
├── constants.ts        # 常量定义（DEFAULT_PROVIDER_TIMEOUT）
└── index.ts            # 统一再导出（向后兼容）
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

## transform — 安全 JSON 解析 + MIME 类型推断

```typescript
import { safeParseJson, mimeToMediaType } from '@/utils';

// 安全解析 JSON：失败不抛异常，包装为 { result: value }
const parsed = safeParseJson('{"key": "val"}');  // { key: 'val' }
const fallback = safeParseJson('not-json');       // { result: 'not-json' }

// MIME 类型 → 内部媒体类型
mimeToMediaType('image/png');   // 'image'
mimeToMediaType('audio/mp3');   // 'audio'
mimeToMediaType('video/mp4');   // 'video'
mimeToMediaType('application/pdf'); // 'file'
```

## math — 通用数值计算

```typescript
import { roundRate, safeRate, roundOrNull } from '@/utils';

roundRate(3.14159);               // 3.14（四舍五入到 2 位小数）
safeRate(5, 10);                  // 0.5（避免除零，保留 4 位小数）
roundOrNull(null);                // null
roundOrNull(3.7);                 // 4
```

> 来源：从 `src/db/stats/helpers.ts` 提取，消除跨领域重复定义。

## headers — 请求头脱敏与格式转换

```typescript
import { sanitizeHeaders, expressHeadersToRecord } from '@/utils';

// 脱敏敏感头（Authorization, x-api-key, cookie, x-goog-api-key）
const clean = sanitizeHeaders(req.headers);
// { authorization: 'sk-abc12345...', 'content-type': 'application/json', ... }

// Express OutgoingHttpHeaders → 纯 Record
const record = expressHeadersToRecord(res.getHeaders());
// { 'content-type': 'application/json', 'content-length': '1234', ... }
```

> 来源：从 `src/model/http/app/helpers.ts` 提取。

## 新增 / 重构 / 删除向导

### 新增工具函数

1. 按职能归入对应子目录：加密 → `crypto/`、HTTP → `http/`、SQL → `sql/`；通用纯函数可放根目录
2. 在对应子目录的 `index.ts`（或根 `index.ts`）中添加再导出语句
3. 新工具不应依赖项目内部模块（`types/`、`config/` 等），保持工具层的单向依赖

### 重构

- **换日志库**：只需修改 `logger.ts`，其他模块的调用方式不变
- **扩展错误格式**：在 `errors.ts` 的 `handleError` 中添加新的 `format` 分支，并同步更新对应的用户适配器
- **新增加密工具**：放入 `crypto/` 子目录，在 `crypto/index.ts` + 根 `index.ts` 中导出

### 删除工具函数

1. 从对应文件中删除函数
2. 在对应的 `index.ts`（子目录 barrel + 根 barrel）中移除再导出
3. 运行 `npm run check:types` 找出所有引用并一并删除
