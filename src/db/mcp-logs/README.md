# src/db/mcp-logs — MCP 调用日志模块

> 父模块：参见 [db/README.md](../README.md)

## 简介

管理 MCP 工具调用日志的持久化，支持写入、查询和统计分析。

采用**冷热双表**架构（对标 `request_logs` / `request_log_details`）：

- **`mcp_logs`（窄热表）**：常用过滤字段（status、method、tool_name、error_message）存储为独立列，支持高效索引查询，列表接口仅查此表
- **`mcp_log_details`（冷宽表）**：存储 `McpGatewayContext` 完整 JSONB 快照（含 audit.params/result/error/timing），仅在详情页按 ID 点查时 JOIN

## 目录结构

```
mcp-logs/
├── queries.ts   # 读写操作（insertMcpLog / listMcpLogs / getMcpLogById / deleteMcpLogById）
├── stats.ts     # 统计分析函数（getMcpStatsOverview / getMcpStatsTimeSeries / getMcpMethodBreakdown）
├── types.ts     # 类型定义（McpLogListItem / McpLogEntry / McpLogCreateInput / McpLogQuery 等）
└── index.ts     # 统一导出
```

## 核心接口

### 日志操作

| 函数 | 说明 |
|---|---|
| `insertMcpLog(ctx: McpGatewayContext)` | 单次写入双表（completed/error 直接写，同时写窄表 + 冷表） |
| `listMcpLogs(query)` | 分页查询，仅查窄表（支持 virtual_mcp_id / mcp_provider_id / app_id / status / method / tool_name 过滤） |
| `getMcpLogById(id)` | 获取单条日志详情（JOIN 冷表返回完整 mcp_context） |
| `deleteMcpLogById(id)` | 删除单条日志（双表删除，返回 boolean） |

### 统计分析

| 函数 | 说明 |
|---|---|
| `getMcpStatsOverview(params)` | MCP 概览：总调用量、错误率、P50/P95 延迟（基于 status 列，无 JSONB 扫描） |
| `getMcpStatsTimeSeries(params, interval?)` | 调用量时序数据 |
| `getMcpMethodBreakdown(params)` | 按 method 分组统计（tools/list、tools/call） |

参数均支持 `range`（15m/1h/6h/24h/7d/14d/30d）和 `from/to` 两种时间模式，以及 `dimension`（global/mcp_provider/virtual_mcp）维度过滤。

## 写入架构

```
MCP 请求  →  McpGatewayContext
          ↓
    insertMcpLog(ctx)
         ├── INSERT mcp_logs        (窄热表：status/method/tool_name/error_message/duration_ms)
         └── INSERT mcp_log_details (冷宽表：mcp_context JSONB 完整快照)
```

**单次写入**：直接写 `completed` 或 `error` 最终状态，无 `processing` 中间态（MCP 调用耗时极短，不需要中间可见状态）。`status` 字段和 `updated_at` 列保留，为未来异步 MCP 任务场景预留扩展点。

## 关键类型

```typescript
// 写入输入（即 McpGatewayContext）
type McpLogCreateInput = McpGatewayContext;

// 列表页（仅窄表字段）
interface McpLogListItem {
  id: string;
  virtual_mcp_id: string | null;
  mcp_provider_id: string | null;
  app_id: string | null;
  session_id: string;
  status: 'processing' | 'completed' | 'error';
  method: string;
  tool_name: string | null;       // 从 McpGatewayContext.toolName 提取
  error_message: string | null;   // 从 McpGatewayContext.errorMessage 提取
  duration_ms: number | null;
  created_at: string;
  updated_at: string;
}

// 详情页（含冷表 mcp_context）
interface McpLogEntry extends McpLogListItem {
  mcp_context: McpGatewayContext | null;
}
```

## 新增/重构/删除向导

### 新增过滤条件

在 `listMcpLogs()` 的 `conditions` 数组中追加新条件（仅允许窄表列），并在 `McpLogQuery` 接口中声明对应参数。

### 新增统计指标

在 `stats.ts` 中新增函数，所有聚合须基于 `mcp_logs` 窄表列（`status`、`duration_ms` 等），禁止对 `mcp_log_details.mcp_context` 做聚合操作。

### 新增分区

参照 `src/db/sql/schema/04_mcp_tables.sql` 中现有分区语句，为 `mcp_logs` 和 `mcp_log_details` 同时新增对应的月分区。
