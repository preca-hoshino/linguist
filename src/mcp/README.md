# src/mcp — MCP 代理网关

> 项目总览：参见 [README.md](../README.md)
>
> 相关模块：[`src/api/README.md`](../api/README.md)（HTTP 接入层）、[`src/db/README.md`](../db/README.md)（日志持久化）

## 简介

实现 MCP（Model Context Protocol）代理网关，将客户端通过 SSE 长连接发送的工具调用请求路由至真实的 MCP 提供商。支持三种传输方式：SSE、stdio 和 Streamable HTTP。工具访问控制和调用日志在此模块统一处理。

## 目录结构

```
mcp/
├── index.ts           # 模块出口：导出 handleMcpSseConnect / handleMcpMessage，提供初始化/关闭钩子
├── providers/         # MCP 提供商连接客户端
│   ├── base-client.ts         # McpProviderClient 抽象基类（连接管理、listTools、callTool）
│   ├── connection-manager.ts  # 全局连接池（按 provider ID 缓存客户端实例）
│   ├── sse-client.ts          # SSE 传输实现
│   ├── stdio-client.ts        # stdio 传输实现
│   ├── http-client.ts         # HTTP 传输实现（简单直连）
│   └── streamable-http-client.ts  # Streamable HTTP 传输实现（MCP 2025 标准）
└── virtual/           # 虚拟 MCP 服务器（聚合层）
    ├── server.ts              # handleMcpSseConnect / handleMcpMessage 实现，会话管理
    └── tool-registry.ts       # 工具白名单过滤（filterTools / isToolAllowed）
```

## 完整数据流

```
客户端
  │  GET /mcp/sse (X-Mcp-Name: <name>)
  ▼
api/http/mcp/               ← 路由层：name → ID 反查、鉴权、白名单校验
  │
  ▼
mcp/virtual/server.ts       ← 虚拟 MCP 服务器：SSE 建连、工具白名单、日志记录
  │  tools/list, tools/call
  ▼
mcp/providers/connection-manager.ts  ← 连接池：复用/新建 MCP 客户端连接
  │
  ▼
真实 MCP 提供商（SSE / stdio / Streamable HTTP）
```

## 虚拟 MCP 服务器

`virtual/server.ts` 使用 `@modelcontextprotocol/sdk` 的 `Server` 实现聚合层：

- **SSE 会话管理**：每次连接创建新的 `McpSession`（含 `sessionId`、`virtualMcpId`、transport、server），存入内存 Map，2 小时自动清理
- **工具代理**：`tools/list` 从真实提供商获取工具后通过 `filterTools()` 按白名单过滤；`tools/call` 先校验 ACL 再转发
- **调用日志**：所有 `tools/list` 和 `tools/call` 操作（含错误）均通过 `insertMcpLog()` 异步写入数据库

## 提供商连接池

`providers/connection-manager.ts` 维护全局连接池（`Map<providerId, McpProviderClient>`）：

- **按需建联**：首次调用 `getClient(provider)` 时自动实例化并连接对应传输的客户端
- **连接复用**：同一 `provider.id` 复用已建立的客户端实例
- **传输类型选择**：根据 `McpProviderRow.kind` 字段自动选择 `SseClient`、`StdioClient` 或 `StreamableHttpClient`
- **优雅关闭**：`disconnectAll()` 断开所有活跃连接（在 `shutdownMcpGateway()` 中调用）

## 新增 / 重构向导

### 新增 MCP 提供商传输类型

1. 在 `src/mcp/providers/` 下新建 `<transport>-client.ts`，继承 `McpProviderClient`，实现 `createTransport()` 方法
2. 在 `connection-manager.ts` 的 `createClient()` 工厂函数中添加 `case` 分支

### 新增工具过滤规则

修改 `virtual/tool-registry.ts` 中的 `filterTools` / `isToolAllowed` 逻辑，白名单配置来自 `VirtualMcpRow.config.tools`

### 删除/停用 MCP 网关

1. 从 `src/api/http/mcp/index.ts` 移除 MCP 路由注册
2. 在 `src/index.ts` 中停用 `initMcpGateway()` 和 `shutdownMcpGateway()` 调用
