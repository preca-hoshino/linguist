# src/db/mcp-virtual-servers — 虚拟 MCP 服务器数据模块

> 父模块：参见 [db/README.md](../README.md)

## 简介

管理虚拟 MCP 服务器的配置持久化，对应 `mcp_virtual_servers`（或 `virtual_mcp_servers`）数据库表。虚拟 MCP 是面向用户的工具聚合层，通过 `name` 作为外部标识符路由 MCP 请求，内部通过 `mcp_provider_id` 关联到真实提供商。

## 目录结构

```
mcp-virtual-servers/
├── queries.ts   # CRUD 操作（listVirtualMcps / getVirtualMcpById / getVirtualMcpByName / createVirtualMcp / updateVirtualMcp / deleteVirtualMcp）
├── types.ts     # 类型定义（VirtualMcpRow / VirtualMcpCreateInput / VirtualMcpUpdateInput）
└── index.ts     # 统一导出
```

## 核心接口

| 函数 | 说明 |
|---|---|
| `listVirtualMcps(opts)` | 分页查询（支持 search/is_active/mcp_provider_id 过滤） |
| `getVirtualMcpById(id)` | 按内部 ID 查询（管理操作使用） |
| `getVirtualMcpByName(name)` | **按名字查询**（SSE 连接时路由层使用，仅返回 `is_active = true` 的记录） |
| `createVirtualMcp(input)` | 创建虚拟 MCP（必填 name、mcp_provider_id；name 唯一且不允许空格） |
| `updateVirtualMcp(id, input)` | 更新虚拟 MCP |
| `deleteVirtualMcp(id)` | 删除虚拟 MCP |

## VirtualMcpRow 字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string UUID | 内部唯一标识（在白名单和日志中使用） |
| `name` | string | **外部唯一名称**（仅允许字母/数字/连字符/下划线/点，全局唯一约束） |
| `mcp_provider_id` | string UUID | 关联的真实 MCP 提供商 ID |
| `config` | JSONB | 配置（含 `tools: string[]` 工具白名单） |
| `is_active` | boolean | 是否启用（`getVirtualMcpByName` 仅返回活跃记录） |
| `created_at` | timestamp | 创建时间 |
| `updated_at` | timestamp | 最后更新时间 |

## 命名约束

`name` 字段在数据库层设有 `UNIQUE` 约束，同时业务层（`admin/mcp-virtual-servers.ts`）在创建和更新时校验格式正则 `/^[a-zA-Z0-9._-]+$/`，不允许含空格。
