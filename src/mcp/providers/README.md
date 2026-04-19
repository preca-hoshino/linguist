# src/mcp/providers — MCP 提供商连接客户端

> 父模块：参见 [mcp/README.md](../README.md)

## 简介

封装与真实 MCP 提供商的连接和通信逻辑，基于 `@modelcontextprotocol/sdk` 构建。提供三种传输实现，通过统一的 `McpProviderClient` 抽象基类对外暴露一致的 `listTools()` / `callTool()` 接口，同时支持 API Key 池轮询和 `{{APIKEY}}` 标记替换。

## 目录结构

```
providers/
├── base-client.ts              # McpProviderClient 抽象基类
│                               #   connect() / disconnect() / listTools() / callTool()
│                               #   getNextApiKey() — API Key 池轮询
│                               #   replaceApiKeyMarker() / replaceApiKeyInObject() — Key 注入
├── connection-manager.ts       # 全局连接池 McpConnectionManager
│                               #   getClient(provider) — 按需建联 + 复用
│                               #   disconnectAll() — 优雅关闭所有连接
├── sse-client.ts               # SSE 传输：继承 McpProviderClient，使用 SSEClientTransport
├── stdio-client.ts             # stdio 传输：继承 McpProviderClient，使用 StdioClientTransport
├── http-client.ts              # HTTP 传输：简单 HTTP 直连
└── streamable-http-client.ts   # Streamable HTTP 传输：MCP 2025 标准，基于 HTTP + Server-Sent Events
```

## McpProviderClient 抽象基类

所有传输实现须继承 `McpProviderClient` 并实现 `createTransport()` 方法：

```typescript
export abstract class McpProviderClient {
  // 子类实现：创建对应传输层的 Transport 实例
  protected abstract createTransport(apiKey: string | undefined): Transport;

  async connect(): Promise<void>;     // 建立连接（从 API Key 池轮询 Key）
  async disconnect(): Promise<void>;  // 断开连接
  async listTools(): Promise<McpToolInfo[]>;
  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
}
```

## API Key 注入机制

`base-client.ts` 提供 `{{APIKEY}}` 占位符替换：提供商配置的 URL、headers 等字段中可嵌入 `{{APIKEY}}`，连接时自动替换为当前轮询到的 Key，实现无侵入的认证注入。

## 全局连接池

`connection-manager.ts` 的 `mcpConnectionManager` 单例：

| 操作 | 说明 |
|------|------|
| `getClient(provider)` | 按 `provider.id` 查找缓存；未命中则根据 `provider.kind` 实例化对应传输客户端并建联 |
| `disconnectAll()` | 遍历所有缓存连接逐一断开，用于服务优雅关闭 |

连接池不限制连接数量，每个提供商最多保持一个活跃连接。

## 新增传输类型

1. 在 `providers/` 下新建 `<transport>-client.ts`，继承 `McpProviderClient`，实现 `createTransport(apiKey)` 方法
2. 在 `connection-manager.ts` 的 `createClient()` 工厂函数中新增 `case` 分支
3. 在 `src/db/mcp-providers/types.ts` 中扩展 `McpProviderKind` 枚举/联合类型
