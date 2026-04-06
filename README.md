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
| **多协议无缝接入**   | 兼容 OpenAI、Anthropic 和 Gemini 等多种接口格式，双向自动转换，消除应用侧生态孤岛。                                     |
| **高可用弹性路由**   | 提供细粒度的模型映射与提供商回退机制，支持智能负载均衡与故障自动转移，保障服务高可用。                                  |
| **零停机热部署**     | 依赖 PostgreSQL `LISTEN/NOTIFY` 机制，任何提供商或模型配置的变更均毫秒级同步集群生效。                                  |
| **系统级可观测性**   | 精确记录跨组件请求生命周期的全量全息审计日志，提供包含错误链路与 Token 成本的深度追踪。                                 |
| **现代化集中管理**   | 提供开箱即用的 Admin API，将所有厂商资源纳入同一控制面板。                                |

---

## 快速开始

推荐使用 Docker 进行部署。你也可以在本地环境直接运行。

### 方式一：Docker 部署 (推荐生产使用)

要求：Docker (>= 20.10), Docker Compose (>= 2.0)

```bash
cp .env.example .env
docker-compose up -d
```
> 可使用 `docker-compose logs -f` 查看日志。

### 方式二：本地开发部署

要求：Node.js (>= 18), PostgreSQL (>= 14)

```bash
# 1. 安装依赖并配置环境变量
npm install
cp .env.example .env

# 2. 初始化/迁移数据库
npm run db:migrate

# 3. 启动开发服务器
npm run dev
```

> **Tips:** 
> - 运行 `npm run build && npm start` 可编译并直接以生产模式启动。
> - 若需重建数据（测试或开发），可使用破坏性指令 `npm run db:reset` 快速重置。

---

## API 端点与能力矩阵

Linguist 完全解耦了**用户端的请求接口**和**后端的模型提供商**。你可以用任何支持的格式，无缝调用任何后端的模型。

### 1. 用户 API 接口 (请求入站)

客户端可以通过以下标准的端点和格式直接接入网关：

| 客户端协议 | 聊天补全端点 (Chat) | 文本嵌入端点 (Embedding) | 其他端点 |
| ---------- | ------------------- | ------------------------ | -------- |
| **OpenAI** 兼容 | `POST /v1/chat/completions` | `POST /v1/embeddings` | `GET /v1/models` |
| **Anthropic** 原生 | `POST /v1/messages` | *(暂不支持)* | - |
| **Gemini** 原生 | `POST /v1beta/models/:model:generateContent`<br>`POST /v1beta/models/:model:streamGenerateContent` | `POST /v1beta/models/:model:embedContent` | - |

> ✨ *所有 Chat 端点均原生支持并自动处理流式（SSE）传输与非流式调用。*

### 2. 后端提供商支持 (模型出站)

网关动态对接下述大型模型厂商平台，并支持高级特性及自动错误代码映射：

| 服务提供商 | `kind` 标识 | 模型能力支持情况 | 厂商专有特性 |
| ---------- | ----------- | ---------------- | ------------ |
| **Google Gemini** | `gemini` | ✅ Chat <br> ✅ Embedding | 自动处理 Search Grounding、System Instructions |
| **火山引擎 (ByteDance)** | `volcengine` | ✅ Chat <br> ✅ Embedding | 自动适配方舟引擎及内部网络错误重试 |
| **DeepSeek** | `deepseek` | ✅ Chat | 完美处理 DeepSeek Reasoner 思考推理过程 |


## 模块架构概览

> 各目录详细核心设计及使用说明参见 `src/<module>/README.md`。

- **[`src/app/`](src/app/README.md)**: 核心请求流水线（通用中间件执行、统一流程编排、双向流式传输控制）
- **[`src/api/`](src/api/README.md)** & **[`src/users/`](src/users/README.md)**: 用户端 HTTP 路由端点分配，及外部传入请求与内部类型的标准化双向适配器
- **[`src/providers/`](src/providers/README.md)**: 提供商统一引擎层（负责重试处理与调度），以及各家厂商具体模型特性的双向转换适配器和 API 封装
- **[`src/config/`](src/config/README.md)** & **[`src/router/`](src/router/README.md)**: 基于 PostgreSQL Listen/Notify 的高可用内存动态配置管理器，多策略底层软路由抽象
- **[`src/db/`](src/db/README.md)**: 安全的 PostgreSQL 数据库连接池、鉴权状态缓存、请求级审计落库以及基于 SQL 的高性能实时业务分析 (`stats`)
- **[`src/admin/`](src/admin/README.md)**: 面向后台维护的 RESTful 服务端点

---


## 技术栈

- **运行时**：Node.js 18+
- **语言**：TypeScript 5
- **Web 框架**：Express 5
- **数据库**：PostgreSQL 14+（基于 `pg` 连接池）
- **日志**：Winston（结构化 JSON 日志）
- **测试框架**：Jest + @swc/jest（涵盖 supertest 与 nock）
- **工具与规范**：ESLint + Oxlint + Prettier + Knip

