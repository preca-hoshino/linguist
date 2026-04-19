# src/admin — 管理 API 模块

> 项目总览：参见 [README.md](../README.md)
> 
> 相关模块：[`src/db/README.md`](../db/README.md)（数据操作）、[`src/config/README.md`](../config/README.md)（配置管理）

## 简介

提供 RESTful 管理接口，支持用户认证与管理、网关三层模型配置（Provider、ProviderModel、VirtualModel）的增删改查、MCP 提供商与虚拟 MCP 管理、应用（App）及 API Key 管理，以及审计请求日志和统计查询。采用 JWT Bearer Token 认证机制，配置变更后由数据库触发器自动通知 `ConfigManager` 热更新，无需重启服务。

## 目录结构

```
admin/
├── index.ts               # 聚合所有子路由，统一挂载认证中间件，导出 adminRouter
├── auth.ts                # JWT Bearer Token 认证中间件，校验 Authorization 头与 JWT_SECRET
├── idempotency.ts         # Stripe 风格幂等性中间件（Idempotency-Key 捕获）
├── error.ts               # 管理 API 统一错误处理器
├── login.ts               # POST /api/login 登录端点（无需认证）
├── me.ts                  # GET /api/me 当前登录用户信息
├── copilot-oauth.ts       # Copilot OAuth 登录流程 /oauth/copilot
├── providers.ts           # /api/providers — 提供商 CRUD
├── provider-models.ts     # /api/provider-models — 提供商模型 CRUD
├── virtual-models.ts      # /api/virtual-models — 虚拟模型 CRUD（含后端关联管理）
├── request-logs.ts        # /api/request-logs — 请求日志查询与删除
├── apps.ts                # /api/apps — 应用（App）CRUD 及 API Key 轮换
├── users.ts               # /api/users — 用户 CRUD（含头像获取公开路由）
├── stats.ts               # /api/stats — 模型网关统计查询
├── mcp-providers.ts       # /api/mcp-providers — MCP 提供商 CRUD
├── mcp-virtual-servers.ts # /api/virtual-mcps — 虚拟 MCP CRUD
├── mcp-logs.ts            # /api/mcp-logs — MCP 调用日志查询与删除
└── mcp-stats.ts           # /api/mcp-stats — MCP 统计查询
```

## API 端点

### 认证

| 方法   | 路径                       | 说明                                        | 认证     |
| ------ | -------------------------- | ------------------------------------------- | -------- |
| POST   | `/api/login`               | 用户登录（邮箱+密码，返回 JWT Token）        | 无需认证 |
| GET    | `/api/me`                  | 获取当前登录用户信息                         | 需要认证 |
| POST   | `/oauth/copilot/...`       | Copilot OAuth 认证流程                       | 无需认证 |

### 模型网关配置

| 方法   | 路径                       | 说明                                                                                      | 认证     |
| ------ | -------------------------- | ----------------------------------------------------------------------------------------- | -------- |
| GET    | `/api/providers`           | 列出所有提供商                                                                            | 需要认证 |
| POST   | `/api/providers`           | 创建提供商（支持 credential_type / credential / config 字段）                             | 需要认证 |
| GET    | `/api/providers/:id`       | 获取单个提供商详情                                                                        | 需要认证 |
| PATCH  | `/api/providers/:id`       | 更新提供商（凭证留空则保持原值）                                                          | 需要认证 |
| DELETE | `/api/providers/:id`       | 删除提供商                                                                                | 需要认证 |
| GET    | `/api/provider-models`     | 列出提供商模型（可按 provider_id 过滤）                                                   | 需要认证 |
| POST   | `/api/provider-models`     | 创建提供商模型                                                                            | 需要认证 |
| GET    | `/api/provider-models/:id` | 获取单个提供商模型                                                                        | 需要认证 |
| PATCH  | `/api/provider-models/:id` | 更新提供商模型                                                                            | 需要认证 |
| DELETE | `/api/provider-models/:id` | 删除提供商模型                                                                            | 需要认证 |
| GET    | `/api/virtual-models`      | 列出虚拟模型（含后端列表）                                                                | 需要认证 |
| POST   | `/api/virtual-models`      | 创建虚拟模型（可同时关联后端）                                                            | 需要认证 |
| GET    | `/api/virtual-models/:id`  | 获取单个虚拟模型详情                                                                      | 需要认证 |
| PATCH  | `/api/virtual-models/:id`  | 更新虚拟模型（可同时替换后端）                                                            | 需要认证 |
| DELETE | `/api/virtual-models/:id`  | 删除虚拟模型                                                                              | 需要认证 |

### MCP 网关配置

| 方法   | 路径                             | 说明                                                                 | 认证     |
| ------ | -------------------------------- | -------------------------------------------------------------------- | -------- |
| GET    | `/api/mcp-providers`             | 列出 MCP 提供商（支持 search/is_active/kind 过滤）                  | 需要认证 |
| POST   | `/api/mcp-providers`             | 创建 MCP 提供商（必填 name、kind）                                   | 需要认证 |
| GET    | `/api/mcp-providers/:id`         | 获取单个 MCP 提供商详情                                              | 需要认证 |
| GET    | `/api/mcp-providers/:id/tools`   | 实时查询 MCP 提供商的工具列表（需连接成功）                          | 需要认证 |
| PATCH  | `/api/mcp-providers/:id`         | 更新 MCP 提供商                                                      | 需要认证 |
| DELETE | `/api/mcp-providers/:id`         | 删除 MCP 提供商                                                      | 需要认证 |
| GET    | `/api/virtual-mcps`              | 列出虚拟 MCP（支持 search/is_active/mcp_provider_id 过滤）          | 需要认证 |
| POST   | `/api/virtual-mcps`              | 创建虚拟 MCP（必填 name、mcp_provider_id；name 不允许含空格）        | 需要认证 |
| GET    | `/api/virtual-mcps/:id`          | 获取单个虚拟 MCP 详情                                                | 需要认证 |
| PATCH  | `/api/virtual-mcps/:id`          | 更新虚拟 MCP                                                         | 需要认证 |
| DELETE | `/api/virtual-mcps/:id`          | 删除虚拟 MCP                                                         | 需要认证 |

### 请求日志与统计

| 方法   | 路径                       | 说明                                                                          | 认证     |
| ------ | -------------------------- | ----------------------------------------------------------------------------- | -------- |
| GET    | `/api/request-logs`        | 查询模型请求日志（分页）                                                       | 需要认证 |
| GET    | `/api/request-logs/:id`    | 获取单条模型请求日志详情（含完整 GatewayContext 审计快照）                     | 需要认证 |
| DELETE | `/api/request-logs/:id`    | 删除单条模型请求日志                                                           | 需要认证 |
| GET    | `/api/mcp-logs`            | 查询 MCP 调用日志（支持 virtual_mcp_id/mcp_provider_id/method 过滤）          | 需要认证 |
| GET    | `/api/mcp-logs/:id`        | 获取单条 MCP 日志详情                                                          | 需要认证 |
| DELETE | `/api/mcp-logs/:id`        | 删除单条 MCP 日志                                                              | 需要认证 |
| GET    | `/api/stats/overview`      | 模型网关统计概览（支持 range/dimension/id 参数）                               | 需要认证 |
| GET    | `/api/stats/time-series`   | 模型时序数据查询                                                               | 需要认证 |
| GET    | `/api/stats/errors`        | 模型错误统计汇总                                                               | 需要认证 |
| GET    | `/api/stats/tokens`        | Token 用量统计                                                                 | 需要认证 |
| GET    | `/api/stats/today`         | 今日实时模型指标                                                               | 需要认证 |
| GET    | `/api/stats/breakdown`     | 模型分组聚合查询                                                               | 需要认证 |
| GET    | `/api/mcp-stats/overview`  | MCP 统计概览（支持 range/from/to/dimension/id 参数）                          | 需要认证 |
| GET    | `/api/mcp-stats/time-series` | MCP 时序数据查询（支持 interval 参数）                                       | 需要认证 |
| GET    | `/api/mcp-stats/methods`   | MCP 工具调用方法分布                                                           | 需要认证 |

### 用户与应用管理

| 方法   | 路径                       | 说明                                                                          | 认证     |
| ------ | -------------------------- | ----------------------------------------------------------------------------- | -------- |
| GET    | `/api/users`               | 列出用户（支持搜索、分页）                                                    | 需要认证 |
| POST   | `/api/users`               | 创建用户（用户名、邮箱、密码、头像）                                          | 需要认证 |
| GET    | `/api/users/:id`           | 获取单个用户详情                                                              | 需要认证 |
| PATCH  | `/api/users/:id`           | 更新用户（支持部分字段）                                                      | 需要认证 |
| DELETE | `/api/users/:id`           | 删除用户                                                                      | 需要认证 |
| GET    | `/api/users/:id/avatar`    | 获取用户头像二进制流（公开，无需认证）                                        | 无需认证 |
| GET    | `/api/apps`                | 列出应用（游标分页，支持 search/is_active 过滤）                              | 需要认证 |
| POST   | `/api/apps`                | 创建应用（必填 name；可选 allowed_model_ids、allowed_mcp_ids）                | 需要认证 |
| GET    | `/api/apps/:id`            | 获取单个应用详情                                                              | 需要认证 |
| PATCH  | `/api/apps/:id`            | 更新应用（name/is_active/allowed_model_ids/allowed_mcp_ids）                  | 需要认证 |
| DELETE | `/api/apps/:id`            | 删除应用                                                                      | 需要认证 |
| POST   | `/api/apps/:id/rotate-key` | 轮换应用 API Key                                                              | 需要认证 |

## 输入校验

- **创建提供商** (`POST /api/providers`)：`kind` 字段校验是否已注册（通过 `getRegisteredProviderKinds()`），未知 kind 返回 400
- **创建/更新虚拟 MCP** (`POST /api/virtual-mcps`)：`name` 字段不允许含空格，只允许字母、数字、连字符、下划线、点，违规返回 400

## 认证

管理 API 采用 JWT Bearer Token 认证机制：

1. **登录获取 Token**：使用 `POST /api/login`（邮箱+密码）获取 JWT Token，有效期 24 小时
2. **后续请求携带 Token**：

```
Authorization: Bearer <jwt_token>
```

`JWT_SECRET` 从环境变量读取。未配置时返回 500；Token 无效或过期时返回 401。

> **注意**：`/api/login`、`/api/users/:id/avatar` 和 Copilot OAuth 路由为公开端点，无需认证。

## 幂等性

所有 `POST` 请求支持 `Idempotency-Key` 请求头，由 `idempotency.ts` 中间件统一处理，防止重复创建资源。

## 配置热更新

`providers`、`provider-models`、`virtual-models` 的增删改操作完成后，数据库触发器自动发送 `pg_notify('config_channel', ...)`，`ConfigManager` 收到通知后重载内存配置，**无需重启服务**。

## 新增 / 重构 / 删除向导

### 新增管理端点

1. 在 `src/admin/` 下新建或在已有文件中添加路由（推荐按资源类型拆分文件）
2. 在 `src/admin/index.ts` 中 `import` 新路由并 `adminRouter.use(newRoute)` 挂载；认证中间件已在 `index.ts` 统一注册，无需在各子文件重复添加
3. 在 `src/db/` 下添加对应的数据库访问函数（如需操作数据库）
4. **同步更新项目根目录的 `admin.http`**，添加可执行示例，保持与实现一致

### 重构

- **调整认证逻辑**：只需修改 `auth.ts`，所有路由自动生效
- **调整路由路径**：修改对应文件中的路由定义，并同步更新 `admin.http`
- **调整数据库操作**：修改 `src/db/` 中对应的函数，admin 路由层通常不需要改动

### 删除管理端点

1. 从对应文件中删除路由处理函数（或删除整个文件）
2. 在 `src/admin/index.ts` 中移除对应的 `import` 和 `adminRouter.use(...)` 行
3. 如有专属数据库操作函数，同步从 `src/db/` 中删除
4. **同步从 `admin.http` 中移除对应示例请求**

## 示例请求

详见项目根目录的 `admin.http` 文件（需安装 VS Code REST Client 扩展）。
