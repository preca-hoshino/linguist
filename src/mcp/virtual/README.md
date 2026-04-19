# src/mcp/virtual — 虚拟 MCP 服务器

> 父模块：参见 [mcp/README.md](../README.md)
>
> 相关模块：[`src/mcp/providers/README.md`](../providers/README.md)（下游提供商客户端）

## 简介

基于 `@modelcontextprotocol/sdk` 实现虚拟 MCP 服务器聚合层，将客户端的 `tools/list` 和 `tools/call` 请求代理至真实 MCP 提供商，同时负责工具白名单过滤、会话生命周期管理和调用日志写入。

## 目录结构

```
virtual/
├── server.ts          # 核心聚合逻辑
│                      #   handleMcpSseConnect() — 建立 SSE 会话、注册工具处理程序
│                      #   handleMcpMessage()    — 将客户端 JSON-RPC 消息路由到对应会话
│                      #   McpSession 接口         — 会话元数据类型
└── tool-registry.ts   # 工具白名单过滤
│                      #   isToolAllowed(toolName, allowedTools) — 判断单个工具是否允许
│                      #   filterTools(tools, allowedTools) — 按白名单批量过滤工具列表
```

## 会话管理

每次 SSE 连接建立时，`handleMcpSseConnect()` 创建一个 `McpSession` 并存入内存 Map：

```typescript
interface McpSession {
  sessionId: string;      // 由 SSEServerTransport 生成
  virtualMcpId: string;   // 对应的虚拟 MCP 内部 ID
  transport: SSEServerTransport;
  server: Server;
  createdAt: number;      // 时间戳（ms），用于超时清理
}
```

- **超时清理**：每小时检查一次，超过 2 小时无活动的 Session 自动释放
- **消息路由**：`handleMcpMessage()` 通过 `?sessionId=` 参数找到对应 Session 并调用 `transport.handlePostMessage()`

## 工具代理流程

```
tools/list 请求
  1. 从连接池获取 provider 客户端
  2. listTools() 获取原始工具列表
  3. filterTools() 按 virtualMcp.config.tools 白名单过滤
  4. 记录 MCP 日志（方法：tools/list）
  5. 返回过滤后的工具列表

tools/call 请求
  1. isToolAllowed() 校验工具名称是否在白名单中
  2. 从连接池获取 provider 客户端
  3. callTool() 执行工具调用
  4. 记录 MCP 日志（方法：tools/call，含参数和结果）
  5. 返回调用结果
```

## 工具白名单

`tool-registry.ts` 实现了最简白名单过滤：`allowedTools` 为空数组时不过滤（放行所有工具）。白名单配置保存在 `virtual_mcp_servers.config.tools` JSONB 字段中，由管理 API 写入。

> **注意**：`call-throttle.ts` 和 `tool-acl.ts` 在 `middleware/mcp/` 中为 Phase 4 占位，完整的工具访问控制将在后续版本实现。

## 新增 / 重构向导

- **修改工具过滤逻辑**：编辑 `tool-registry.ts`，支持通配符、正则等更复杂的过滤规则
- **扩展会话元数据**：在 `McpSession` 接口中添加字段，在 `handleMcpSseConnect()` 中赋值
- **更改调用日志格式**：修改 `server.ts` 中的 `logMcp()` 辅助函数调用
