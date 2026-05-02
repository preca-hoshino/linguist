---
description: '错误处理规范 — GatewayError、错误码、handleError、异常捕获'
applyTo: 'src/**/*.ts'
---

# 错误处理规范

统一错误策略：业务错误用 `GatewayError` 抛出 → `handleError()` 转换为格式特定的 JSON 响应。

---

## 1. 必须抛出 `GatewayError`

```typescript
import { GatewayError } from '@/utils/errors';

// ✅ 正确
throw new GatewayError(404, 'model_not_found', 'Model gpt-5 not found');

// ✅ 携带提供商原始错误（第四参数）
throw new GatewayError(503, 'no_backend_available', 'All providers exhausted', {
  providerId: 'xxx', statusCode: 503, rawError: 'upstream timeout',
});

// ❌ 禁止 throw 普通 Error 或字符串
```

## 2. 错误码速查表

**禁止随意造新码**，必须从下表选择：

| 状态码 | errorCode                  | 使用场景                       |
| ------ | -------------------------- | ------------------------------ |
| 400    | `invalid_request`          | 请求体格式错误 / JSON 解析失败 |
| 400    | `invalid_range`            | 分页参数越界                   |
| 400    | `invalid_dimension`        | Embedding 维度不匹配           |
| 400    | `missing_id`               | 缺少必需 ID 参数               |
| 400    | `invalid_interval`         | 统计时间范围无效               |
| 400    | `invalid_group_by`         | 不支持的聚合维度               |
| 400    | `unknown_format`           | 未注册的 API 格式              |
| 400    | `capability_not_supported` | 模型不支持请求的能力           |
| 400    | `model_type_mismatch`      | Chat/Embedding 类型错配        |
| 400    | `stream_not_supported`     | 模型不支持流式                 |
| 400    | `invalid_model`            | 无效模型标识                   |
| 400    | `bad_request`              | 其他通用 400                   |
| 401    | `unauthorized`             | 缺少认证凭据                   |
| 401    | `invalid_api_key`          | API Key 无效或已停用           |
| 402    | `insufficient_balance`     | 余额不足                       |
| 403    | `forbidden`                | 无权限访问                     |
| 404    | `not_found`                | 资源不存在（通用）             |
| 404    | `model_not_found`          | 模型不存在                     |
| 409    | `conflict`                 | 唯一键冲突                     |
| 500    | `internal_error`           | 内部未预期错误                 |
| 500    | `route_error`              | 路由解析失败                   |
| 503    | `no_backend_available`     | 所有后端提供商不可用           |

## 3. 标准 try-catch 模板

```typescript
// ✅ 正确 — 区分 GatewayError 与未知错误，catch 用 unknown
try {
  await someOperation();
} catch (err: unknown) {
  if (err instanceof GatewayError) throw err; // 可预期错误直接传递
  logger.error({ err }, 'Unexpected error');
  throw new GatewayError(500, 'internal_error', 'Operation failed');
}

// ❌ 禁止 catch (err: any) 或 throw new Error(...)
```

## 4. `handleError()` 使用位置

在 **endpoint handler 层** 调用，**不在中间件层**：

```typescript
import { handleError } from '@/model/http/users';

app.post('/model/openai-compat/v1/chat/completions', async (req, res) => {
  try {
    // ... 请求处理 ...
  } catch (err: unknown) {
    handleError(err, res, 'openaicompat');
  }
});
```

## 5. 中间件层错误处理

中间件 **不吞掉错误**，通过 `throw` 向上传递：

```typescript
// ✅ 正确 — 直接抛出 GatewayError
export async function apiKeyAuth(ctx: ModelHttpContext): Promise<void> {
  if (!ctx.apiKey) throw new GatewayError(401, 'unauthorized', 'API key is required');
}

// ❌ 禁止在中间件内 try-catch 并静默吞掉错误
```
