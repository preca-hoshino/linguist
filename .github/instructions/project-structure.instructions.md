---
description: 'Use when creating, moving, or organizing source files — directory structure, module placement, code organization, three-layer isolation (HTTP/WS/MCP)'
applyTo: 'src/**/*.ts'
---

# 目录结构规范 — 三层网关物理隔离

Linguist 采用三层物理隔离架构：**HTTP V1（无状态）→ WebSocket V2（有状态）→ MCP（协议代理）**。禁止跨层耦合。

> 完整蓝图参见：`docs/mcp-gateway-architecture.md`

---

## 1. 三层分界线

```
src/
├── api/http/          # V1 HTTP REST 端点（薄入口，仅解析 → 分发到 model/http/）
│   ├── openaicompat/
│   ├── anthropic/
│   ├── gemini/
│   └── mcp/           # MCP Streamable HTTP 端点
│
├── api/ws/            # V2 WebSocket 端点（独立，不复用 HTTP 路由逻辑）
│   └── realtime/      # OpenAI Realtime 协议握手
│
├── model/http/        # V1 核心网关（无状态）
│   ├── app/           #   请求处理管道（process.ts）
│   ├── router/        #   模型路由与负载均衡
│   ├── users/         #   入站格式适配（openaicompat / anthropic / gemini）
│   │   ├── openaicompat/{chat,embedding}/
│   │   ├── anthropic/{chat}/
│   │   └── gemini/{chat,embedding}/
│   └── providers/     #   出站适配（deepseek / gemini / volcengine / copilot）
│       └── <provider>/{chat,embedding}/
│
├── model/ws/          # V2 核心网关（有状态，长连接）
│   ├── engine/        #   事件总线、状态机、流管理
│   ├── users/         #   WebSocket 协议转译
│   └── providers/     #   上游连接管理
│
├── mcp/               # MCP 协议网关（独立子系统）
│   ├── virtual/       #   前端虚拟 MCP Server
│   └── providers/     #   后端 MCP Client（stdio/sse/http/streamable-http）
│
├── middleware/
│   ├── common/        #   基础公共（auth / cors / request-id / error-handler / logger）
│   ├── model/         #   模型治理
│   │   ├── http/      #     V1 HTTP（token-counter / quota-checker / rate-limiter / cost-logger）
│   │   │   ├── request/   # 请求阶段
│   │   │   └── response/  # 响应阶段
│   │   └── ws/        #     V2 WebSocket（session-lock / stream-splitter / billing-accumulator / reconnect-handler）
│   └── mcp/           #   MCP（tool-acl / call-throttle）
│
├── types/             # 类型定义（通用 → 放根目录；专属 → 内聚到模块）
│   ├── context.ts     #   ModelHttpContext
│   ├── session.ts     #   ModelWsContext
│   ├── realtime.ts    #   InternalWSFrame + 客户端/服务端事件
│   ├── mcp.ts         #   MCP 协议映射
│   └── ...
│
├── db/                # 数据库层（按领域分目录：apps / users / stats / billing / mcp-* / request-logs）
├── config/            # 动态配置（ConfigManager + PG Listen/Notify）
└── utils/             # 纯工具函数（logger / jwt / sse / hash / media / ...）
```

---

## 2. 文件命名规范

| 后缀 / 规则           | 用途                                                | 示例                                     |
| --------------------- | --------------------------------------------------- | ---------------------------------------- |
| `*.client.ts`         | 上游 HTTP/SSE 网络调用                              | `chat/client.ts`                         |
| `request/` 目录       | `InternalXxxRequest → 外部格式` 转换                | `chat/request/index.ts`                  |
| `response/` 目录      | `外部响应 → InternalXxxResponse` 转换               | `chat/response/index.ts`                 |
| `error-mapping.ts`    | 提供商错误码 → `GatewayError`（每个 provider 必须） | `providers/gemini/error-mapping.ts`      |
| `error-formatting.ts` | 用户格式错误响应构建（每个 user format 必须）       | `users/openaicompat/error-formatting.ts` |
| `types.ts`            | 模块专属类型（不放 `src/types/`）                   | `middleware/types.ts`                    |
| `index.ts`            | 模块公共导出                                        | 所有目录                                 |
| `README.md`           | 模块说明（一级子目录建议）                          | `db/apps/README.md`                      |
| `__tests__/`          | 单元测试，与源文件同级                              | `chat/request/__tests__/`                |

> **通用类型** 放 `src/types/`（跨模块共享）；**模块专属类型** 放模块内 `types.ts`。

---

## 3. 模块放置决策

| 场景      | 目录                                              |
| --------- | ------------------------------------------------- |
| HTTP 端点 | `src/api/http/<format>/`                          |
| WS 端点   | `src/api/ws/<format>/`                            |
| 入站适配  | `src/model/http/users/<format>/<modality>/`       |
| 出站适配  | `src/model/http/providers/<provider>/<modality>/` |
| WS 协议层 | `src/model/ws/<engine\|users\|providers>/`        |
| MCP 功能  | `src/mcp/<virtual\|providers>/`                   |
| 中间件    | 见下表                                            |
| DB 查询   | `src/db/<domain>/`                                |

### 中间件放置

| 范围                                        | 目录                     |
| ------------------------------------------- | ------------------------ |
| 所有请求（Auth / CORS / RequestID / Error） | `middleware/common/`     |
| HTTP Chat/Embedding                         | `middleware/model/http/` |
| WebSocket 长连接                            | `middleware/model/ws/`   |
| MCP 工具调用                                | `middleware/mcp/`        |

---

## 4. 文件行数建议

| 行数           | 状态     | 说明                                                       |
| -------------- | -------- | ---------------------------------------------------------- |
| **≤ 300 行**   | ✅ 推荐   | AI 友好，可一次性理解上下文                                |
| **300–500 行** | 🟡 可接受 | 评估是否可按职责拆分                                       |
| **> 500 行**   | 🔴 应拆分 | 拆为子目录，通过 `index.ts` barrel export 保持导入路径不变 |

> 单个函数建议 **≤ 50 行**。

---

## 5. 禁止事项

- ❌ **跨层耦合**：WS 不 import HTTP 路由；HTTP 中间件不依赖 WS 类型
- ❌ **嵌套过深**：适配器内部最多 2 级（`chat/request/`）
- ❌ **类型散落**：共享类型 → `types/`；专属类型 → 模块内 `types.ts`
- ❌ **Provider 缺文件**：`error-mapping.ts` + `index.ts` 必须存在
