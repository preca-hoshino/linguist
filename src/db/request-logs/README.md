# src/db/request-logs — 模型请求日志模块

> 父模块：参见 [db/README.md](../README.md)

## 简介

管理模型 HTTP 网关的请求日志生命周期：从请求进入（`processing`）→ 完成（`completed`）或 失败（`error`），并存储完整的 GatewayContext 审计快照。

## 目录结构

```
request-logs/
├── types.ts    # LogRow 类型定义 + ENTRY_COLUMNS 查询列常量
├── write.ts    # 写入操作（markProcessing / markCompleted / markError）
├── read.ts     # 查询操作（queryRequestLogs / getRequestLogById / deleteRequestLogById）
└── index.ts    # 统一导出
```

## 日志状态机

```
请求进入 → [markProcessing] → 状态: processing
                               ↓
           提供商响应完成 → [markCompleted] → 状态: completed
           请求出错      → [markError]     → 状态: error
```

`markError` 使用 UPSERT（`ON CONFLICT(id) DO UPDATE`），兼容路由前就失败（记录尚未创建）的场景。

## 核心接口

| 函数 | 说明 |
|---|---|
| `markProcessing(ctx)` | 创建日志记录，状态 `processing`，fire-and-forget |
| `markCompleted(ctx)` | 更新状态为 `completed`，记录 token 用量、耗时、完整 `gateway_context` |
| `markError(ctx, error)` | UPSERT 状态为 `error`，记录错误信息 |
| `queryRequestLogs(query)` | 分页查询（支持 status/model/provider/error_type/app_id 过滤） |
| `getRequestLogById(id)` | 查询单条日志（含完整 `gateway_context` 审计快照） |
| `deleteRequestLogById(id)` | 删除单条日志 |

## 审计数据结构

`gateway_context` JSONB 列是审计日志的唯一完整来源，包含四次 HTTP 交换的头部和请求/响应体：

```
gateway_context.audit.userRequest.headers / .body
gateway_context.audit.providerRequest.headers / .body
gateway_context.audit.providerResponse.headers / .body
gateway_context.audit.userResponse.headers / .body
```
