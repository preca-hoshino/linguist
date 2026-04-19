# src/db/mcp-logs — MCP 调用日志模块

> 父模块：参见 [db/README.md](../README.md)

## 简介

管理 MCP 工具调用日志的持久化，支持写入、查询和统计分析，对应 `mcp_logs` 数据库表。

## 目录结构

```
mcp-logs/
├── queries.ts   # 读写操作（insertMcpLog / listMcpLogs / getMcpLogById / deleteMcpLogById）
├── stats.ts     # 统计分析函数（getMcpStatsOverview / getMcpStatsTimeSeries / getMcpMethodBreakdown）
├── types.ts     # 类型定义（McpLogRow / McpLogCreateInput / McpStatsQueryParams 等）
└── index.ts     # 统一导出
```

## 核心接口

### 日志操作

| 函数 | 说明 |
|---|---|
| `insertMcpLog(input)` | 写入单条 MCP 调用日志（fire-and-forget，在 virtual/server.ts 调用） |
| `listMcpLogs(opts)` | 分页查询（支持 virtual_mcp_id / mcp_provider_id / app_id / method 过滤） |
| `getMcpLogById(id)` | 获取单条日志详情 |
| `deleteMcpLogById(id)` | 删除单条日志（返回 boolean） |

### 统计分析

| 函数 | 说明 |
|---|---|
| `getMcpStatsOverview(params)` | MCP 概览：总调用量、成功率、平均耗时 |
| `getMcpStatsTimeSeries(params, interval?)` | 调用量时序数据 |
| `getMcpMethodBreakdown(params)` | 按 method（tools/list、tools/call）分组统计 |

参数均支持 `range`（15m/1h/6h/24h/7d/14d/30d）和 `from/to` 两种时间模式，以及 `dimension`（global/mcp_provider/virtual_mcp）维度过滤。

## 日志字段

```typescript
interface McpLogCreateInput {
  id: string;              // UUID
  virtual_mcp_id?: string; // 虚拟 MCP 内部 ID
  mcp_provider_id?: string;// MCP 提供商内部 ID
  app_id?: string;         // 关联的 App ID（来自 SSE 连接时注入的 appId）
  session_id: string;      // SSE 会话 ID
  method: string;          // 'tools/list' 或 'tools/call'
  params?: object;         // 调用参数（JSONB）
  result?: object;         // 调用结果（JSONB）
  error?: object;          // 错误详情（JSONB，成功时为 null）
  duration_ms?: number;    // 耗时（毫秒）
}
```
