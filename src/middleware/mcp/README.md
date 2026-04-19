# src/middleware/mcp — MCP 专属中间件

> 父模块：参见 [middleware/README.md](../README.md)

## 简介

存放 MCP 网关专属的横切中间件。当前处于 **Phase 4 占位**阶段，核心访问控制逻辑将在后续版本实现；MCP 的鉴权和白名单校验目前由路由层（`src/api/http/mcp/`）直接处理。

## 目录结构

```
mcp/
├── tool-acl.ts       # checkToolAcl() — 工具访问控制列表（TODO: 按 App 配置过滤可访问工具）
└── call-throttle.ts  # applyCallThrottle() — 工具调用频率防护（TODO: 防刷屏与调用均衡）
```

## 当前状态

| 文件                | 函数                  | 状态         | 说明                                            |
| ------------------- | --------------------- | ------------ | ----------------------------------------------- |
| `tool-acl.ts`       | `checkToolAcl()`      | Phase 4 占位 | 待实现：根据 App 的 allowedMcpIds 过滤工具清单   |
| `call-throttle.ts`  | `applyCallThrottle()` | Phase 4 占位 | 待实现：Tool-Call 高频请求防护和调用均衡         |

## 新增 MCP 中间件

当需要实现工具访问控制或调用限流时：

1. 在此目录创建/修改对应文件，实现具体逻辑
2. 在 `src/mcp/virtual/server.ts` 的 `handleMcpSseConnect()` 中在适当位置调用（连接建立时或每次工具调用前）
3. 若需作用于所有 MCP 请求的前置处理，也可挂载为 `api/http/mcp/` 路由的 Express 中间件
