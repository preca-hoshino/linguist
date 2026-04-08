# src/api — 用户 API 格式路由

> 项目总览：参见 [README.md](../README.md)
>
> 相关模块：[`src/app/README.md`](../app/README.md)（核心流程）、[`src/users/README.md`](../users/README.md)（用户适配器）

## 简介

负责将各种用户 API 格式（OpenAI 兼容格式、Anthropic 格式、Gemini 原生格式等）的 HTTP 端点注册到 Express，提取请求中的 `model` 字段和 API Key，然后将处理委托给 `src/app/` 中格式无关的核心流程（`processChatCompletion` / `processEmbedding`）。每种格式是独立的子目录，互不干扰。

## 目录结构

```
api/
├── index.ts              # 聚合所有格式路由，注册 API Key 提取器，导出 apiRouter
├── auth-helper.ts        # 共享 API Key 验证逻辑（供非核心流程端点使用，如 /v1/models）
├── openaicompat/
│   └── index.ts          # OpenAI 兼容格式端点
├── anthropic/
│   └── index.ts          # Anthropic Messages API 端点
└── gemini/
    └── index.ts          # Gemini 原生格式端点
```

## 已支持的 API 格式

### OpenAI 兼容格式 (`openaicompat`)

| 端点                   | 方法 | model 来源   | API Key 来源                  |
| ---------------------- | ---- | ------------ | ----------------------------- |
| `/v1/models`           | GET  | —            | `Authorization: Bearer <key>` |
| `/v1/chat/completions` | POST | `body.model` | `Authorization: Bearer <key>` |
| `/v1/embeddings`       | POST | `body.model` | `Authorization: Bearer <key>` |

### Anthropic 格式 (`anthropic`)

| 端点           | 方法 | model 来源   | API Key 来源       |
| -------------- | ---- | ------------ | ------------------ |
| `/v1/models`   | GET  | —            | `x-api-key` header |
| `/v1/messages` | POST | `body.model` | `x-api-key` header |

### Gemini 原生格式 (`gemini`)

| 端点                                          | 方法 | model 来源        | API Key 来源                                |
| --------------------------------------------- | ---- | ----------------- | ------------------------------------------- |
| `/v1beta/models`                              | GET  | —                 | `x-goog-api-key` header 或 `?key=` 查询参数 |
| `/v1beta/models/:model:generateContent`       | POST | URL 路径 `:model` | `x-goog-api-key` header 或 `?key=` 查询参数 |
| `/v1beta/models/:model:streamGenerateContent` | POST | URL 路径 `:model` | `x-goog-api-key` header 或 `?key=` 查询参数 |
| `/v1beta/models/:model:embedContent`          | POST | URL 路径 `:model` | `x-goog-api-key` header 或 `?key=` 查询参数 |

## 核心组件

### API Key 提取器注册中心

`api/index.ts` 维护了一个 `apiKeyExtractors` 字典，按用户格式存储对应的 API Key 提取函数：

```typescript
// 注册提取器
registerApiKeyExtractor('openaicompat', openaiCompatExtractApiKey);
registerApiKeyExtractor('gemini', geminiExtractApiKey);
registerApiKeyExtractor('anthropic', claudeExtractApiKey);

// 获取提取器（找不到时抛出错误）
const extractor = getApiKeyExtractor(format);
```

### 路由聚合

```typescript
const apiRouter: Router = Router();
apiRouter.use(openaiCompatRouter);
apiRouter.use(geminiRouter);
apiRouter.use(anthropicRouter);
```

## 新增 / 重构 / 删除向导

### 新增用户 API 格式

1. 在 `src/api/<format>/` 下创建 `index.ts`，实现：
   - **Express 路由**：定义端点，从请求中提取 `rawModel`（字符串），调用 `processChatCompletion(req, res, '<format>', rawModel)` 或 `processEmbedding(...)`
   - **`extractApiKey(req)`**：从请求头或查询参数中提取 API Key（返回 `string | undefined`），并导出

2. 在 `api/index.ts` 中：
   - `import` 新格式的路由和 `extractApiKey`
   - 调用 `registerApiKeyExtractor('<format>', newExtractApiKey)` 注册提取器
   - `apiRouter.use(newFormatRouter)` 挂载路由

3. 在 `src/users/` 下同步创建对应的用户格式适配器（请求/响应转换）—— 参见 [`src/users/README.md`](../users/README.md)

### 重构

- **更改端点路径**：只需修改对应 `<format>/index.ts` 中的路由路径，核心流程不受影响。
- **更改 model 提取逻辑**：只修改对应的 `<format>/index.ts`，不影响其他格式。
- **更改 API Key 提取方式**：修改 `<format>/index.ts` 中的 `extractApiKey`，并确认 `api/index.ts` 中注册的格式字符串与 `processChatCompletion` 传入的 `userFormat` 一致。

### 删除用户 API 格式

1. 删除 `src/api/<format>/` 目录
2. 在 `api/index.ts` 中移除对应的 `import`、`registerApiKeyExtractor` 调用和 `apiRouter.use(...)` 行
3. 同步删除 `src/users/<category>/<format>/` 中的用户适配器 —— 参见 [`src/users/README.md`](../users/README.md)
