---
description: '错误处理规范 — GatewayError、错误码、handleError、异常捕获'
applyTo: 'src/**/*.ts'
---

# 错误处理规范

## 概述
本文件定义 Linguist Gateway 的统一错误处理策略：使用 `GatewayError` 抛出所有可预期业务错误，经 `handleError()` 统一转换为格式特定的错误 JSON 响应。

---

## 核心规则

### 1. 必须抛出 `GatewayError`

所有可预期的业务错误 **必须** 使用 `GatewayError`：

```typescript
import { GatewayError } from '@/utils/errors';

// ✅ 正确 — 使用 GatewayError
throw new GatewayError(404, 'model_not_found', 'Model gpt-5 not found');

// ✅ 携带提供商原始错误（第四参数）
throw new GatewayError(503, 'no_backend_available', 'All providers exhausted', {
  providerId: 'xxx',
  statusCode: 503,
  rawError: 'upstream timeout',
});
```

```typescript
// ❌ 错误 — 不要 throw 普通 Error
throw new Error('Something went wrong');
// ❌ 错误 — 不要 throw 字符串
throw 'invalid input';
```

### 2. 完整错误码速查表

`errorCode` 必须从以下已定义集合中选择，**禁止随意造新码**：

#### 400 — 请求错误

| errorCode                  | 使用场景                      | 示例                                                                              |
| -------------------------- | ----------------------------- | --------------------------------------------------------------------------------- |
| `invalid_request`          | 请求体格式错误、JSON 解析失败 | `throw new GatewayError(400, 'invalid_request', 'Malformed JSON body')`           |
| `invalid_range`            | 分页参数越界                  | `throw new GatewayError(400, 'invalid_range', 'Offset exceeds total count')`      |
| `invalid_dimension`        | Embedding 维度不匹配          | `throw new GatewayError(400, 'invalid_dimension', 'Expected 1536, got 768')`      |
| `missing_id`               | 缺少必需的 ID 参数            | `throw new GatewayError(400, 'missing_id', 'App ID is required')`                 |
| `invalid_interval`         | 统计时间范围无效              | `throw new GatewayError(400, 'invalid_interval', 'End must be after start')`      |
| `invalid_group_by`         | 不支持的聚合维度              | `throw new GatewayError(400, 'invalid_group_by', 'Unsupported group-by: color')`  |
| `unknown_format`           | 未注册的 API 格式             | `throw new GatewayError(400, 'unknown_format', 'Unknown format: mistral')`        |
| `capability_not_supported` | 模型不支持请求的能力          | `throw new GatewayError(400, 'capability_not_supported', 'Vision not supported')` |
| `model_type_mismatch`      | Chat/Embedding 类型错配       | `throw new GatewayError(400, 'model_type_mismatch', 'Expected chat model')`       |
| `stream_not_supported`     | 模型不支持流式                | `throw new GatewayError(400, 'stream_not_supported', 'Streaming not available')`  |
| `invalid_model`            | 无效的模型标识                | `throw new GatewayError(400, 'invalid_model', 'Invalid model name')`              |
| `bad_request`              | 其他通用 400 错误             | `throw new GatewayError(400, 'bad_request', 'Invalid parameter: top_p')`          |

#### 401 — 认证错误

| errorCode         | 使用场景             | 示例                                                                            |
| ----------------- | -------------------- | ------------------------------------------------------------------------------- |
| `unauthorized`    | 缺少认证凭据         | `throw new GatewayError(401, 'unauthorized', 'API key is required')`            |
| `invalid_api_key` | API Key 无效或已停用 | `throw new GatewayError(401, 'invalid_api_key', 'Invalid or inactive API key')` |

#### 402 — 计费错误

| errorCode              | 使用场景 |
| ---------------------- | -------- |
| `insufficient_balance` | 余额不足 |

#### 403 — 权限错误

| errorCode   | 使用场景   |
| ----------- | ---------- |
| `forbidden` | 无权限访问 |

#### 404 — 未找到

| errorCode         | 使用场景           |
| ----------------- | ------------------ |
| `not_found`       | 资源不存在（通用） |
| `model_not_found` | 模型不存在         |

#### 409 — 冲突

| errorCode  | 使用场景   |
| ---------- | ---------- |
| `conflict` | 唯一键冲突 |

#### 500 — 服务器错误

| errorCode        | 使用场景       |
| ---------------- | -------------- |
| `internal_error` | 内部未预期错误 |
| `route_error`    | 路由解析失败   |

#### 503 — 服务不可用

| errorCode              | 使用场景             |
| ---------------------- | -------------------- |
| `no_backend_available` | 所有后端提供商不可用 |

### 3. 标准 try-catch 模板

```typescript
// ✅ 正确 — 区分 GatewayError 与未知错误
try {
  await someOperation();
} catch (err: unknown) {
  if (err instanceof GatewayError) {
    // 可预期的业务错误 — 直接传递
    throw err;
  }
  // 未知错误 — 包装为 GatewayError
  logger.error({ err }, 'Unexpected error during operation');
  throw new GatewayError(500, 'internal_error', 'Operation failed');
}
```

```typescript
// ❌ 错误 — 参数类型不是 unknown
try {
  await something();
} catch (err: any) {  // ← 禁止 any
  throw new Error(err.message);  // ← 禁止 throw 普通 Error
}
```

### 4. `handleError()` 使用位置

`handleError()` 定义在 `src/model/http/users/error-handler.ts`，必须在 **endpoint handler 层** 调用，不在中间件层调用：

```typescript
// ✅ 正确 — 在 handler 层统一处理
import { handleError } from '@/model/http/users';

app.post('/model/openai-compat/v1/chat/completions', async (req, res) => {
  try {
    // ... 请求处理 ...
  } catch (err: unknown) {
    handleError(err, res, 'openaicompat');
  }
});
```

### 5. 中间件层错误处理

中间件 **不吞掉错误**，通过 `throw` 向上传递：

```typescript
// ✅ 正确 — 中间件直接抛出 GatewayError
export async function apiKeyAuth(ctx: ModelHttpContext): Promise<void> {
  if (!ctx.apiKey) {
    throw new GatewayError(401, 'unauthorized', 'API key is required');
  }
  // ...
}
```

```typescript
// ❌ 错误 — 在中间件内 try-catch 并静默
export async function badMiddleware(ctx: ModelHttpContext): Promise<void> {
  try {
    // ...
  } catch {
    // 吞掉错误 — 请求继续执行
  }
}
```

---

## 常见陷阱

| 陷阱                          | 正确做法                                    |
| ----------------------------- | ------------------------------------------- |
| 在中间件内 try-catch 吞掉错误 | 抛出 GatewayError 让 handler 层统一处理     |
| 随意创造新 errorCode          | 从本文档的错误码表中选择                    |
| 忘记 `Object.setPrototypeOf`  | `GatewayError` 构造函数已处理，无需手动维护 |
| 用 `any` 捕获异常             | 始终使用 `unknown` + `instanceof` 分派      |

---

## 项目参考

- `src/utils/errors.ts` — `GatewayError` 类定义
- `src/model/http/users/error-handler.ts` — `handleError()` 实现
- `src/api/http/auth-helper.ts` — API Key 提取与错误场景
- `src/middleware/common/api-key-auth.ts` — 中间件层 GatewayError 抛出示例
