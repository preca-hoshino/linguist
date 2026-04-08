# src/app — 核心流程编排

> 项目总览：参见 [README.md](../README.md)
>
> 相关模块：[`src/api/README.md`](../api/README.md)（调用入口）、[``src/router/README.md`](../router/README.md)（路由解析）、[`src/providers/README.md`](../providers/README.md)（提供商调用）

## 简介

实现网关的核心请求处理流水线，将用户适配、中间件、路由、提供商调用、响应适配等各阶段编排为统一流程。所有 API 格式路由（`src/api/`）将处理委托给此模块的入口函数。

## 目录结构

```
app/
├── process.ts     # 主处理流程（processChatCompletion / processEmbedding / processRequest）
├── stream.ts      # 流式传输（processStreamSend / mergeStreamChunks）
├── helpers.ts     # 辅助函数（finalizeSuccess / finalizeError / sanitizeHeaders / expressHeadersToRecord）
├── index.ts       # 统一导出入口
└── __tests__/     # 单元测试
```

## 核心流程

`processRequest()` 实现了格式无关的 10 步通用流水线：

```
1. 创建最小 ctx（确保 catch 块始终有 requestId 可用）
2. 提取 API Key → 写入 ctx
3. 校验 model 字段
4. 用户请求适配 → ctx.request（内部统一格式）
5. 请求中间件链（apiKeyAuth, normalizeChatToolCallIds）
6. 路由 → assertRouted，INSERT 日志行（processing）
7. 路由后中间件（rateLimit）
8. 调度 + 发送（唯一因 stream/type 分叉的阶段）
   ├─ 非流式：dispatch → 响应中间件 → 适配 → sendJSON
   └─ 流式：processStreamSend（内部建连、SSE 传输）
9. success: finalizeSuccess → markCompleted
10. catch: finalizeError → handleError → markError
```

## 中间件

### 请求阶段（requestMiddlewares）
| 中间件 | 说明 |
|--------|------|
| `apiKeyAuth` | API Key 提取与鉴权 |
| `normalizeChatToolCallIds` | 规范化工具调用 ID 为 UUID v5 |

### 路由后阶段（postRouteMiddlewares）
| 中间件 | 说明 |
|--------|------|
| `rateLimit` | 速率限制检查 |

### 响应阶段（responseMiddlewares）
| 中间件 | 说明 |
|--------|------|
| `normalizeResponseChatToolCallIds` | 规范化响应中的工具调用 ID |
| `tokenAccounting` | Token 用量统计 |

## 公开入口

| 函数 | 说明 |
|------|------|
| `processChatCompletion` | 聊天请求入口，支持流式（SSE）和非流式 |
| `processEmbedding` | 嵌入请求入口，仅支持非流式 |

- `processChatCompletion(req, res, userFormat, modelName, options?)`：可选 `options.stream` 用于强制覆盖流式标记（如 Gemini 由 URL 端点决定流式）
- `processEmbedding(req, res, userFormat, modelName)`

两者内部均调用 `processRequest()` 统一处理。

## 流式传输

`processStreamSend(ctx, res, middlewares)` 负责流式响应的完整生命周期：

1. **建立连接**：调用 `dispatchChatProviderStream` 获取流
2. **发送响应头**：`Content-Type: text/event-stream`、`Cache-Control: no-cache`、`Connection: keep-alive`
3. **逐 chunk 写入**：
   - 对工具调用 ID 进行 UUID v5 规范化
   - 记录 TTFT（Time To First Token，首 Token 到达时间）
   - 调用用户流式响应适配器转换并写入
4. **发送结束标记**：`[DONE]`
5. **合并 chunks**：调用 `mergeStreamChunks()` 将所有 chunk 合并为等效的非流式响应
6. **响应中间件链**
7. **审计**：记录 provider 和 user 格式的非流式响应

### TTFT 记录

流式处理中会记录首 Token 到达时间，用于性能监控：

```typescript
if (!ttftRecorded) {
  const hasContent = chunk.choices.some(c => 
    c.delta.content !== undefined || 
    c.delta.reasoning_content !== undefined || 
    c.delta.tool_calls?.length
  );
  if (hasContent) {
    ctx.timing.ttft = Date.now();
    ttftRecorded = true;
  }
}
```

## 辅助函数

| 函数 | 说明 |
|------|------|
| `finalizeSuccess` | 成功完成后计算耗时、打印日志 |
| `finalizeError` | 错误发生时写入 ctx.error、记录 timing 并打印警告日志 |
| `sanitizeHeaders` | 脱敏请求头（Authorization 等仅保留前 11 位） |
| `expressHeadersToRecord` | 将 Express OutgoingHttpHeaders 转为 HttpHeaders |

## 新增 / 重构向导

### 新增处理阶段

1. 在 `process.ts` 的 `processRequest()` 流水线中插入新步骤
2. 如需在特定阶段执行，添加到对应的中间件数组
3. 如逻辑复杂，抽取到 `helpers.ts` 或新建文件
4. 在 `index.ts` 中按需导出

### 重构

- **修改流式行为**：编辑 `stream.ts`，不影响非流式路径
- **调整中间件挂载**：编辑 `process.ts` 中的中间件数组
- **更改审计日志格式**：编辑 `helpers.ts` 中的 `finalizeSuccess` / `finalizeError`
