# Linguist — LLM Gateway

## 技术栈
Node.js + Express 5 + TypeScript (CommonJS) + PostgreSQL (raw SQL) + Winston

## 项目结构

```
src/
├── server.ts              # Express 应用入口
├── index.ts               # 主入口（启动编排）
├── socket.ts              # WebSocket 网关
├── admin/                 # Admin API 路由 (JWT 鉴权)
├── api/http/              # 用户 API 路由 (API Key 鉴权)
├── config/                # ConfigManager（PostgreSQL LISTEN/NOTIFY 热加载）
├── db/                    # 数据库层（pg Pool + 参数化查询 + 迁移）
├── middleware/             # 中间件链（apiKeyAuth, rateLimit, tokenAccounting 等）
├── model/http/            # 核心路由与协议适配（OpenAI / Anthropic / Gemini）
├── mcp/                   # MCP 协议网关
├── types/                 # 类型定义（ModelHttpContext 为核心）
└── utils/                 # 工具模块（Logger, GatewayError, JWT, SSE 等）
```

## 构建与运行

```bash
npm run dev          # 开发模式（ts-node 热加载）
npm run build        # 构建（tsc + tsc-alias + 复制迁移文件）
npm run check        # 全量检查（format + lint + types + deps + test）
npm run db           # 运行数据库迁移
```

## 细分规范索引

| 领域            | 文件                                                    |
| --------------- | ------------------------------------------------------- |
| 工作流          | `.github/instructions/git-workflow.instructions.md`     |
| 代码风格        | `.github/instructions/code-style.instructions.md`       |
| 错误处理        | `.github/instructions/error-handling.instructions.md`   |
| 日志            | `.github/instructions/logging.instructions.md`          |
| 数据库          | `.github/instructions/database.instructions.md`         |
| 中间件          | `.github/instructions/middleware.instructions.md`       |
| API 设计        | `.github/instructions/api-design.instructions.md`       |
| 管理 API (REST) | `.github/instructions/admin-api-rest.instructions.md`   |
| 管理 API (参数) | `.github/instructions/admin-api-params.instructions.md` |
| 测试            | `.github/instructions/testing.instructions.md`          |
