# Linguist

<div align="center">

🇨🇳 中文 | [🇬🇧 English](README.en.md) | [🇯🇵 日本語](README.ja.md) | [🇫🇷 Français](README.fr.md) | [🇩🇪 Deutsch](README.de.md)

</div>

---

**Linguist** 是一个基于 Node.js + TypeScript 构建的大模型统一网关。它接收多种格式的请求（OpenAI 兼容格式、Gemini 原生格式等），根据数据库中存储的动态配置将请求路由到不同的 AI 模型提供商（DeepSeek、Google Gemini、火山引擎等），并将响应转换回对应的用户格式返回给调用方。

---

## 核心特性

| 特性                 | 说明                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **多格式用户接口**   | 支持 OpenAI 兼容格式和 Gemini 原生格式，客户端无需修改代码即可接入                                                      |
| **多提供商支持**     | DeepSeek、Google Gemini、火山引擎，可扩展添加新提供商                                                                   |
| **三层模型路由**     | Provider → ProviderModel → VirtualModel，支持 simple/load_balance/failover 三种路由策略；其中 failover 自动重试所有后端 |
| **动态配置热更新**   | 配置存储在 PostgreSQL，通过 LISTEN/NOTIFY 实时生效，无需重启                                                            |
| **Chat + Embedding** | 支持聊天补全和文本嵌入两类能力                                                                                          |
| **完整管理 API**     | RESTful 管理接口，支持提供商/模型映射的增删改查                                                                         |
| **请求日志审计**     | 每次请求全生命周期（pending → processing → completed/error）持久化到数据库                                              |
| **管理控制台**       | 基于 Vue 3 + mdui 的现代化管理界面，支持配置管理、日志查看、统计分析                                                    |
| **统计监控**         | 实时统计概览、时序趋势、错误分析、Token 用量等多维度监控                                                                |

---

## 快速开始

> **推荐生产部署使用 Docker Compose**。

### 前置要求

- Node.js >= 18
- PostgreSQL >= 14

### （可选）Docker 部署

如果使用 Docker Compose，仅需：
- Docker >= 20.10
- Docker Compose >= 2.0


### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

创建 `.env` 文件（参考下方环境变量说明）：

```env
# 数据库连接
DATABASE_URL=postgresql://user:password@localhost:5432/linguist

# 管理 API 认证密钥（自定义任意字符串）
ADMIN_KEY=your-secret-admin-key

# 服务端口（默认 3000）
PORT=3000

# 日志级别：error | warn | info | debug（默认 info）
LOG_LEVEL=info
```

### 3. 运行数据库迁移（初次部署）

**生产环境 / 初次部署使用**：
```bash
npm run db:migrate
```

这会创建以下表：
- `providers` — 提供商（API Key、base_url、协议类型）
- `provider_models` — 提供商侧真实模型
- `virtual_models` — 面向用户的虚拟模型
- `virtual_model_backends` — 虚拟模型与提供商模型的关联
- `request_logs` — 请求审计日志

**本地开发环境使用** — 如需清空重建数据库：
```bash
npm run db:reset  # ⚠️ 删除所有数据，仅用于开发！
```

### 4. 启动服务

#### 本地开发模式

```bash
# 开发模式（ts-node，热重载需配合 nodemon）
npm run dev

# 生产模式（先编译）
npm run build && npm start
```

#### Docker Compose 部署（推荐生产环境）

使用 Docker Compose 一键启动后端网关和 PostgreSQL 数据库：

```bash
# 1. 复制环境变量文件
cp .env.example .env

# 2. 启动所有服务（包括数据库初始化）
docker-compose up -d

# 3. 查看服务日志
docker-compose logs -f
```

服务启动后：
- **后端 API**：http://localhost:3000
- **健康检查**：http://localhost:3000/health

详见 [Docker 部署指南](docs/DOCKER.md)。

#### 可用的服务端点

服务启动后，可访问以下端点：

| 方法   | 路径                                      | 说明                         |
| ------ | ----------------------------------------- | ---------------------------- |
| `GET`  | `/api/health`                             | 健康检查                     |
| `GET`  | `/v1/models`                              | 获取模型列表                 |
| `POST` | `/v1/chat/completions`                    | OpenAI 格式聊天补全          |
| `POST` | `/v1/embeddings`                          | OpenAI 格式文本嵌入          |
| `POST` | `/v1beta/models/:model:generateContent`   | Gemini 格式聊天补全          |
| `POST` | `/v1beta/models/:model:streamGenerateContent` | Gemini 格式流式聊天补全  |
| `POST` | `/v1beta/models/:model:embedContent`      | Gemini 格式文本嵌入          |

---

## 配置三层模型（端到端示例）

通过管理 API 配置路由链路，以"用 DeepSeek API 的 deepseek-chat 模型"为例：

> 可直接使用项目根目录的 `admin.http`（需安装 VS Code REST Client 扩展）。

**第一步：创建提供商**

```http
POST http://localhost:3000/api/providers
Authorization: Bearer your-secret-admin-key
Content-Type: application/json

{
  "name": "DeepSeek",
  "kind": "deepseek",
  "base_url": "https://api.deepseek.com/v1",
  "api_key": "sk-xxxxxxxxxxxxxxxx"
}
```

**第二步：创建提供商模型**

```http
POST http://localhost:3000/api/provider-models
Authorization: Bearer your-secret-admin-key
Content-Type: application/json

{
  "provider_id": "<上一步返回的 id>",
  "name": "deepseek-chat",
  "model_type": "chat"
}
```

**第三步：创建虚拟模型（用户请求的 model 字段）**

```http
POST http://localhost:3000/api/virtual-models
Authorization: Bearer your-secret-admin-key
Content-Type: application/json

{
  "id": "deepseek-chat",
  "name": "DeepSeek Chat",
  "routing_strategy": "load_balance",
  "backends": [
    { "provider_model_id": "<上一步返回的 id>" }
  ]
}
```

配置完成后，立即生效（无需重启），发送聊天请求：

```http
POST http://localhost:3000/v1/chat/completions
Content-Type: application/json

{
  "model": "deepseek-chat",
  "messages": [
    { "role": "user", "content": "你好！" }
  ]
}
```

---

## 支持的提供商

| 提供商               | `kind` 值    | Chat  | Embedding |
| -------------------- | ------------ | :---: | :-------: |
| DeepSeek             | `deepseek`   |   ✅   |     —     |
| Google Gemini        | `gemini`     |   ✅   |     ✅     |
| 火山引擎（字节跳动） | `volcengine` |   ✅   |     ✅     |

## 支持的用户 API 格式

| 格式   | 说明           | Chat 端点                     | Embedding 端点              |
| ------ | -------------- | ----------------------------- | --------------------------- |
| OpenAI | 兼容格式        | `/v1/chat/completions`        | `/v1/embeddings`            |
| Gemini | 原生格式        | `/v1beta/models/:model:generateContent` | `/v1beta/models/:model:embedContent` |

---

## API 参考

### 网关 API

| 方法   | 路径                                          | 格式        | 说明                                                 |
| ------ | --------------------------------------------- | ----------- | ---------------------------------------------------- |
| `GET`  | `/api/health`                                 | —           | 健康检查，返回 `{ status: "ok", timestamp, uptime }` |
| `GET`  | `/v1/models`                                  | OpenAI 兼容 | 返回可调用的虚拟模型列表                             |
| `POST` | `/v1/chat/completions`                        | OpenAI 兼容 | 聊天补全（支持流式：`stream: true`）                 |
| `POST` | `/v1/embeddings`                              | OpenAI 兼容 | 文本嵌入                                             |
| `POST` | `/v1beta/models/:model:generateContent`       | Gemini 原生 | 聊天补全（非流式）                                   |
| `POST` | `/v1beta/models/:model:streamGenerateContent` | Gemini 原生 | 聊天补全（流式 SSE）                                 |
| `POST` | `/v1beta/models/:model:embedContent`          | Gemini 原生 | 文本嵌入                                             |

### 管理 API

所有管理接口需要 `Authorization: Bearer <ADMIN_KEY>` 请求头。

| 路径                  | 说明                                   |
| --------------------- | -------------------------------------- |
| `/api/providers`      | 管理提供商（增删改查）                 |
| `/api/provider-models` | 管理提供商模型（增删改查）               |
| `/api/virtual-models` | 管理虚拟模型（增删改查）               |
| `/api/request-logs`   | 查询请求日志（支持过滤和分页）         |
| `/api/api-keys`       | 管理用户 API Key（增删改查、轮换） |

---

## 项目结构

> 各目录详细说明参见 `src/<module>/README.md`

```
src/
├── index.ts           # 进程入口，优雅关闭处理
├── server.ts          # Express 实例与 HTTP 路由注册
├── app/               # 核心流程编排（processChatCompletion / processEmbedding，格式无关）
│   ├── process.ts     # 主处理流程（processChatCompletion / processEmbedding / processRequest）
│   ├── stream.ts      # 流式传输（processStreamSend / mergeStreamChunks）
│   └── helpers.ts     # 辅助函数（finalizeSuccess / finalizeError / sanitizeHeaders）
├── api/               # 用户 API 格式路由（各格式的端点注册和 model 提取）
│   ├── openaicompat/  # OpenAI 兼容格式（/v1/models、/v1/chat/completions、/v1/embeddings）
│   └── gemini/        # Gemini 原生格式（/v1beta/models/:model:generateContent 等）
├── types/             # 统一内部类型（GatewayContext、Internal*）
├── config/            # ConfigManager（内存缓存 + LISTEN/NOTIFY）
├── db/                # PostgreSQL 连接池 + 请求日志 + API Key 操作
├── router/            # 虚拟模型路由解析
├── middleware/        # 中间件链执行器
├── users/             # 用户格式适配器（外部格式 ↔ Internal）
│   ├── error-formatting/   # 用户格式错误响应（按格式拆分）
│   ├── chat/openaicompat/  # OpenAI 兼容格式聊天适配器
│   ├── chat/gemini/        # Gemini 原生格式聊天适配器
│   ├── embedding/openaicompat/ # OpenAI 兼容格式嵌入适配器
│   └── embedding/gemini/   # Gemini 原生格式嵌入适配器
├── providers/         # 提供商适配器（Internal → 厂商格式）
│   ├── error-mapping/ # 提供商错误映射（按厂商拆分）
│   ├── chat/
│   │   ├── deepseek/
│   │   ├── gemini/
│   │   └── volcengine/
│   └── embedding/
│       ├── gemini/
│       └── volcengine/
├── admin/             # 管理 API 路由
└── utils/             # 公用工具（GatewayError、日志、JSON、SSE、SQL 构建）
ui/                   # 管理控制台前端（Vue 3 + TypeScript + mdui）
├── src/api/          # 后端 API 客户端层（类型安全的 HTTP 调用）
├── src/types/        # 前端类型定义（与后端 API 响应结构对应）
├── src/utils/        # 前端工具函数（格式化、DOM 辅助）
└── src/components/   # 业务组件与视图
admin.http             # 管理 API 可执行示例（VS Code REST Client）
```

---

## 🐳 Docker 部署

项目完全支持 Docker 和 Docker Compose 部署，包括后端网关和 PostgreSQL 数据库。

### 一键启动

```bash
# 复制环境变量
cp .env.example .env

# 使用管理脚本（推荐）
chmod +x scripts/docker.sh
./scripts/docker.sh up

# 或直接使用 Docker Compose
docker-compose up -d
```

然后访问：
- **后端 API**：http://localhost:3000

### 详细文档

- **[Docker 部署指南](docs/DOCKER.md)** — 完整部署、生产配置、故障排除
- **[快速参考卡片](docs/DOCKER-QUICK-REF.md)** — 常用命令速查表
- **[部署总结](docs/DOCKER-SUMMARY.md)** — 文件清单和架构说明

### 管理脚本

**Linux/macOS：** `./scripts/docker.sh`  
**Windows：** `scripts\docker.bat`

支持的命令：`up`、`down`、`logs`、`db-backup`、`shell-gateway` 等，运行 `./scripts/docker.sh help` 查看完整列表。

### 包含的服务

| 服务       | 镜像                 | 端口 |
| ---------- | -------------------- | ---- |
| PostgreSQL | `postgres:16-alpine` | 5432 |
| Gateway    | 本地构建             | 3000 |

---

## 开发指南

### 可用命令

```bash
npm run dev        # 开发模式启动（ts-node）
npm run build      # TypeScript 编译到 dist/
npm start          # 生产模式启动（需先 build）
npm test           # 运行 Jest 测试
npm run type-check # TypeScript 类型检查（必须零错误）
npm run lint       # ESLint 检查（必须零错误零警告）
npm run lint:fix   # ESLint 自动修复
npm run format     # Prettier 代码格式化
npm run db:migrate # 执行数据库迁移
npm run db:reset   # ⚠️ 清空重建数据库（仅本地开发）
```

**提交前检查**：在提交代码前必须通过以下检查：
```bash
npm run type-check && npm run lint && npm run format && npm test
```

### 扩展网关

- **新增 AI 提供商**：[`src/providers/README.md`](src/providers/README.md)
- **新增用户 API 格式**：[`src/users/README.md`](src/users/README.md)、[`src/api/README.md`](src/api/README.md)
- **新增中间件**：[`src/middleware/README.md`](src/middleware/README.md)
- **开发管理控制台**：[`ui/README.md`](ui/README.md)
- **提交规范与分支管理**：参见 [CONTRIBUTING.md](CONTRIBUTING.md)

---

## 技术栈

- **运行时**：Node.js 18+
- **语言**：TypeScript 5
- **Web 框架**：Express 5
- **数据库**：PostgreSQL 14+（`pg` 连接池）
- **日志**：Winston（结构化 JSON 日志）
- **测试**：Jest + nock（HTTP mock）
- **代码规范**：ESLint + Prettier

