# src/app — 核心流程编排

> 项目总览：参见 [README.md](../README.md)
> 
> 相关模块：[`src/api/README.md`](../api/README.md)（调用入口）、[`src/router/README.md`](../router/README.md)（路由解析）、[`src/providers/README.md`](../providers/README.md)（提供商调用）

## 简介

实现网关的核心请求处理流水线，将用户适配、中间件、路由、提供商调用、响应适配等各阶段编排为统一流程。所有 API 格式路由（`src/api/`）将处理委托给此模块的入口函数。

## 目录结构

```
app/
├── process.ts    # 主处理流程（processChatCompletion / processEmbedding / processRequest）
├── stream.ts     # 流式传输（processStreamSend / mergeStreamChunks）
├── helpers.ts    # 辅助函数（finalizeSuccess / finalizeError / sanitizeHeaders / expressHeadersToRecord）
└── index.ts      # 统一导出入口
```

## 核心流程

`processRequest()` 实现了格式无关的 7 步通用流水线：

```
1. 创建 GatewayContext
2. 用户请求适配（填充 ctx.request）
3. 请求中间件链（鉴权等）
4. 路由解析（填充 ctx.route）
5. 提供商调用（非流式 / 流式分支）
6. 响应中间件链
7. 用户响应适配 + 发送
```

## 公开入口

| 函数                    | 说明                                  |
| ----------------------- | ------------------------------------- |
| `processChatCompletion` | 聊天请求入口，支持流式（SSE）和非流式 |
| `processEmbedding`      | 嵌入请求入口，仅支持非流式            |

`processChatCompletion` 接收 `(req, res, userFormat, rawModel, options?)` 参数，可选 `options.stream` 用于强制覆盖流式标记（如 Gemini 由 URL 端点决定流式）。`processEmbedding` 接收 `(req, res, userFormat, rawModel)` 参数。两者内部均调用 `processRequest()` 统一处理。

## 流式传输

`processStreamSend(ctx, res)` 负责流式响应的完整生命周期：

1. 设置 SSE 响应头（`Content-Type: text/event-stream`）
2. 逐 chunk 调用用户流式响应适配器转换并写入
3. 发送 `[DONE]` 结束标记
4. 调用 `mergeStreamChunks()` 将所有 chunk 合并为等效的非流式响应，用于审计日志

## 辅助函数

| 函数                     | 说明                                            |
| ------------------------ | ----------------------------------------------- |
| `finalizeSuccess`        | 成功完成后记录审计日志和请求日志                |
| `finalizeError`          | 错误发生时记录审计日志和请求日志                |
| `sanitizeHeaders`        | 从请求头中移除敏感信息（Authorization 等）      |
| `expressHeadersToRecord` | 将 Express IncomingHttpHeaders 转为 Record 格式 |

## 新增 / 重构向导

### 新增处理阶段

1. 在 `process.ts` 的 `processRequest()` 流水线中插入新步骤
2. 如逻辑复杂，抽取到 `helpers.ts` 或新建文件
3. 在 `index.ts` 中按需导出

### 重构

- **修改流式行为**：编辑 `stream.ts`，不影响非流式路径
- **调整中间件挂载**：编辑 `process.ts` 中的中间件数组
- **更改审计日志格式**：编辑 `helpers.ts` 中的 `finalizeSuccess` / `finalizeError`
