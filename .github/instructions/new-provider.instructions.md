---
description: '新提供商接入指南 — ProviderPlugin 接口、适配器四件套、注册流程、同步清单'
applyTo: 'src/model/http/providers/**/*.ts'
---

# 新提供商接入指南

从零添加一个 LLM 提供商适配器的完整步骤。以 `deepseek/` 为最简模板，`gemini/` 为复杂模板（含 embedding + 多模态）。

---

## 前置条件

- 确认提供商 API 文档（认证方式、请求/响应格式、流式协议）
- 确认支持的模型类型：`chat` / `embedding` / `rerank` / `image` / `audio`
- 确认提供商 API 与 OpenAI 兼容程度（决定适配器复杂度）

---

## Step 1: 创建目录结构

```
src/model/http/providers/<kind>/
├── index.ts               # 导出 ProviderPlugin 对象
├── error-mapping.ts       # mapXxxError(status, body) → ProviderErrorInfo
├── chat/                  # Chat 适配器（如支持）
│   ├── client.ts          # HTTP 客户端（实现 ProviderChatClient）
│   ├── request/
│   │   ├── index.ts       # 请求适配器（实现 ProviderChatRequestAdapter）
│   │   └── message-converter.ts  # 消息格式转换（如需）
│   ├── response/
│   │   ├── index.ts       # 响应适配器（实现 ProviderChatResponseAdapter）
│   │   ├── stream.ts      # 流式响应适配器（实现 ProviderChatStreamResponseAdapter）
│   │   └── types.ts       # 提供商原始响应类型定义
│   └── __tests__/
└── embedding/             # Embedding 适配器（如支持）
    ├── client.ts
    ├── request/
    │   └── index.ts
    └── response/
        └── index.ts
```

## Step 2: 实现 `ProviderPlugin`（`index.ts`）

```typescript
import type { ProviderPlugin } from '@/model/http/providers/types';

export const xxxPlugin: ProviderPlugin = {
  kind: 'xxx',                          // 必须唯一，与管理面板 kind 字段一致
  supportedModelTypes: ['chat'],        // 声明支持的模型类型
  supportedChatParameters: [            // 声明原生支持的调优参数
    'temperature', 'top_p', 'max_tokens',
  ] as const,

  getChatAdapterSet: (config) => ({
    requestAdapter: new XxxChatRequestAdapter(),
    responseAdapter: new XxxChatResponseAdapter(),
    streamResponseAdapter: new XxxChatStreamResponseAdapter(),
    client: new XxxChatClient(config),
  }),

  // getEmbeddingAdapterSet: (config) => ({ ... }),  // 如支持 embedding

  mapError: (status, body) => mapXxxError(status, body),
};
```

## Step 3: 实现 Chat 适配器四件套

### 3a. Client（`chat/client.ts`）

实现 `ProviderChatClient` 接口：

```typescript
export class XxxChatClient implements ProviderChatClient {
  constructor(config: ProviderConfig) {
    // 从 config.credential 提取认证信息
    // 从 config.baseUrl 提取 API 基地址
  }

  async call(providerReq, model, options?): Promise<ProviderCallResult> {
    // POST 请求，返回 { body, statusCode, requestHeaders, responseHeaders }
  }

  async callStream(providerReq, model, options?): Promise<ProviderStreamResult> {
    // POST 请求，返回 { response: fetch Response, statusCode, requestHeaders }
  }
}
```

关键点：
- 使用 `fetch` + `AbortSignal.timeout(options?.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT)`
- 错误时调用 `parseProviderResponse()` 统一解析（来自 `http-utils.ts`）
- 支持 `options.headers` 覆盖（`null` 值删除头部）

### 3b. Request Adapter（`chat/request/index.ts`）

实现 `ProviderChatRequestAdapter` 接口：

```typescript
export class XxxChatRequestAdapter implements ProviderChatRequestAdapter {
  toProviderRequest(internalReq, routedModel, modelConfig?) {
    // InternalChatRequest → 提供商 API 请求体
    // 必须设置 model: routedModel
    // 处理 thinking → 提供商特定格式
    // 处理 tools → 提供商特定格式
  }
}
```

### 3c. Response Adapter（`chat/response/index.ts`）

实现 `ProviderChatResponseAdapter` 接口：

```typescript
export class XxxChatResponseAdapter implements ProviderChatResponseAdapter {
  fromProviderResponse(providerRes: unknown): InternalChatResponse {
    // 提供商响应 → InternalChatResponse
    // 映射 finish_reason → 内部 FinishReason 联合类型
    // 映射 usage（含 reasoning_tokens、cached_tokens）
  }
}
```

### 3d. Stream Response Adapter（`chat/response/stream.ts`）

实现 `ProviderChatStreamResponseAdapter` 接口：

```typescript
export class XxxChatStreamResponseAdapter implements ProviderChatStreamResponseAdapter {
  fromProviderStreamChunk(providerChunk: unknown): InternalChatStreamChunk {
    // 提供商 SSE chunk → InternalChatStreamChunk
    // 处理 delta.content、delta.reasoning_content、delta.tool_calls
    // 最后一个 chunk 通常包含 usage 统计
  }
}
```

## Step 4: 实现错误映射（`error-mapping.ts`）

```typescript
export function mapXxxError(httpStatus: number, body: string): ProviderErrorInfo {
  const parsed = tryParseJson(body);
  // 提取提供商错误码和消息
  // 映射 HTTP 状态码 → gatewayErrorCode
  return { gatewayStatusCode, gatewayErrorCode, providerErrorCode, message };
}
```

参考 `errors.ts` 中的工具函数：`tryParseJson`、`extractErrorObj`、`extractString`、`fallbackByStatus`。

## Step 5: 注册插件

在 `src/model/http/providers/index.ts` 中：

```typescript
import { xxxPlugin } from './xxx';
registerPlugin(xxxPlugin);
```

## Step 6: 更新日志缓存

在 `src/model/http/providers/engine.ts` 的 `getProviderLogger` 中添加：

```typescript
xxx: { label: 'Provider:Xxx', logColors.bold + logColors.xxx },
```

## Step 7: 同步参数白名单

如新增了调优参数，需同步更新以下三处：

| 位置            | 文件                                                                              |
| --------------- | --------------------------------------------------------------------------------- |
| 引擎剥离列表    | `engine.ts` → `FILTERABLE_CHAT_PARAMS` / `FILTERABLE_EMBEDDING_PARAMS`            |
| 管理 API 白名单 | `src/admin/model/provider-models.ts` → `CHAT_PARAMETERS` / `EMBEDDING_PARAMETERS` |
| 内部请求类型    | `src/types/chat.ts` / `src/types/embedding.ts`                                    |

## Step 8: 编写单元测试

在 `chat/request/__tests__/` 和 `chat/response/__tests__/` 中编写：
- 请求适配器：内部请求 → 提供商格式的映射正确性
- 响应适配器：提供商响应 → 内部格式的映射正确性（含边界情况）
- 流式适配器：chunk 拼装、usage 提取

## Step 9: 管理面板配置

前端无需代码改动。通过管理 API 配置：

1. **创建 Provider**：`POST /admin/model/providers`（`kind` 必须与插件 `kind` 一致）
2. **创建 ProviderModel**：`POST /admin/model/provider-models`（关联 provider_id）
3. **创建 VirtualModel**：`POST /admin/model/virtual-models`（关联 provider_model_id 作为 backend）
