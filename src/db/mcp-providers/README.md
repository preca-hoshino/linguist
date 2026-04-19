# src/db/mcp-providers — MCP 提供商数据模块

> 父模块：参见 [db/README.md](../README.md)

## 简介

管理 MCP 提供商（真实 MCP 服务器）的配置持久化，对应 `mcp_providers` 数据库表。提供商信息包括传输类型（`kind`）、连接配置（`config` JSONB）和 API Key 池（`credential` 字符串数组）。

## 目录结构

```
mcp-providers/
├── queries.ts   # CRUD 操作（listMcpProviders / getMcpProviderById / createMcpProvider / updateMcpProvider / deleteMcpProvider）
├── types.ts     # 类型定义（McpProviderRow / McpProviderCreateInput / McpProviderUpdateInput / McpProviderKind）
└── index.ts     # 统一导出
```

## 核心接口

| 函数 | 说明 |
|---|---|
| `listMcpProviders(opts)` | 分页查询（支持 search/is_active/kind 过滤） |
| `getMcpProviderById(id)` | 根据 ID 查询单个提供商 |
| `createMcpProvider(input)` | 创建提供商（必填 name、kind） |
| `updateMcpProvider(id, input)` | 更新提供商（`buildUpdateSet` 动态 SQL） |
| `deleteMcpProvider(id)` | 删除提供商 |

## McpProviderRow 字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string UUID | 内部唯一标识 |
| `name` | string | 提供商名称 |
| `kind` | McpProviderKind | 传输类型（`sse` / `stdio` / `streamable_http` 等） |
| `config` | JSONB | 连接配置（URL、环境变量、启动命令等，按 kind 结构不同） |
| `credential` | string[] | API Key 池（在连接 client 时轮询选取） |
| `is_active` | boolean | 是否启用 |
| `created_at` | timestamp | 创建时间 |
| `updated_at` | timestamp | 最后更新时间 |
