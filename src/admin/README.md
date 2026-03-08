# src/admin — 管理 API 模块

> 项目总览：参见 [README.md](../README.md)
> 
> 相关模块：[`src/db/README.md`](../db/README.md)（数据操作）、[`src/config/README.md`](../config/README.md)（配置管理）

## 简介

提供 RESTful 管理接口，支持对网关的三层模型配置（Provider、ProviderModel、VirtualModel）进行增删改查，以及审计请求日志和 API Key 管理。所有接口通过 Bearer Token 认证保护（从环境变量 `ADMIN_KEY` 读取）。配置变更后由数据库触发器自动通知 `ConfigManager` 热更新，无需重启服务。

## 目录结构

```
admin/
├── index.ts            # 聚合所有子路由，统一挂载认证中间件，导出 adminRouter
├── auth.ts             # Bearer Token 认证中间件，校验 Authorization 头与 ADMIN_KEY
├── providers.ts        # /api/providers — 提供商 CRUD
├── provider-models.ts  # /api/provider-models — 提供商模型 CRUD
├── virtual-models.ts   # /api/virtual-models — 虚拟模型 CRUD（含后端关联管理）
├── request-logs.ts     # /api/request-logs — 请求日志查询
├── api-keys.ts         # /api/api-keys — 用户 API Key CRUD 与轮换
└── stats.ts            # /api/stats — 统计与监控查询（概览/时序/错误/Token/今日/分组明细）
```

## API 端点

| 方法   | 路径                       | 说明                                                                                        |
| ------ | -------------------------- | ------------------------------------------------------------------------------------------- |
| GET    | `/api/providers`           | 列出所有提供商（不含 api_key）                                                              |
| POST   | `/api/providers`           | 创建提供商                                                                                  |
| GET    | `/api/providers/:id`       | 获取单个提供商详情                                                                          |
| PUT    | `/api/providers/:id`       | 更新提供商                                                                                  |
| DELETE | `/api/providers/:id`       | 删除提供商                                                                                  |
| GET    | `/api/provider-models`     | 列出提供商模型（可按 provider_id 过滤）                                                     |
| POST   | `/api/provider-models`     | 创建提供商模型                                                                              |
| GET    | `/api/provider-models/:id` | 获取单个提供商模型                                                                          |
| PUT    | `/api/provider-models/:id` | 更新提供商模型                                                                              |
| DELETE | `/api/provider-models/:id` | 删除提供商模型                                                                              |
| GET    | `/api/virtual-models`      | 列出虚拟模型（含后端列表）                                                                  |
| POST   | `/api/virtual-models`      | 创建虚拟模型（可同时关联后端）                                                              |
| GET    | `/api/virtual-models/:id`  | 获取单个虚拟模型详情                                                                        |
| PUT    | `/api/virtual-models/:id`  | 更新虚拟模型（可同时替换后端）                                                              |
| DELETE | `/api/virtual-models/:id`  | 删除虚拟模型                                                                                |
| GET    | `/api/request-logs`        | 查询请求日志（分页，支持按 status/model/provider/error_type/api_key_prefix/is_stream 过滤） |
| GET    | `/api/request-logs/:id`    | 获取单条请求日志详情（含完整 GatewayContext 审计快照）                                      |
| GET    | `/api/api-keys`            | 列出所有 API Key（不含密文）                                                                |
| POST   | `/api/api-keys`            | 创建用户 API Key                                                                            |
| GET    | `/api/api-keys/:id`        | 获取单个 API Key 详情                                                                       |
| PUT    | `/api/api-keys/:id`        | 更新 API Key（名称、过期时间、启用状态等）                                                  |
| DELETE | `/api/api-keys/:id`        | 删除 API Key                                                                                |
| POST   | `/api/api-keys/:id/rotate` | 轮换 API Key（重新生成密钥，返回一次性明文）                                                |
| GET    | `/api/stats/overview`      | 统计概览（RPM/TPM/错误率/延迟等，支持 range/dimension/id 参数）                             |
| GET    | `/api/stats/time-series`   | 时序数据查询（含 P50/P95/P99 延迟、TTFT、Token 分拆、错误类型细分）                         |
| GET    | `/api/stats/errors`        | 错误统计汇总（按类型/状态码分布 + 最近样本）                                                |
| GET    | `/api/stats/tokens`        | Token 用量统计（含百分位数）                                                                |
| GET    | `/api/stats/today`         | 今日实时指标（今日累计 + 最近 1/5 分钟 RPM/TPM/错误率/延迟）                                |
| GET    | `/api/stats/breakdown`     | 分组聚合查询（按 provider/provider_model/virtual_model/api_key/error_type 分组）            |

## 输入校验

- **创建提供商** (`POST /api/providers`)：`kind` 字段会校验是否为已注册的提供商类型（通过 `getRegisteredProviderKinds()` 获取），未知 kind 返回 400
- **创建/更新 API Key**：`expires_at` 字段校验 ISO 8601 日期格式合法性，不合法返回 400

## 认证

所有端点需要请求头：

```
Authorization: Bearer <ADMIN_KEY>
```

`ADMIN_KEY` 从环境变量读取。未配置时返回 500；Token 不匹配时返回 403。

## 配置热更新

`providers`、`provider-models`、`virtual-models` 的增删改操作完成后，数据库触发器自动发送 `pg_notify('config_channel', ...)`，`ConfigManager` 收到通知后重载内存配置，**无需重启服务**。

## 新增 / 重构 / 删除向导

### 新增管理端点

1. 在 `src/api/` 下新建或在已有文件中添加路由（推荐按资源类型拆分文件）
2. 在 `index.ts` 中 `import` 新路由并 `router.use(newRoute)` 挂载；认证中间件已在 `index.ts` 统一注册，无需在各子文件重复添加
3. 在 `src/db/` 下添加对应的数据库访问函数（如需操作数据库）
4. **同步更新项目根目录的 `admin.http`**，添加可执行示例，保持与实现一致

### 重构

- **调整认证逻辑**：只需修改 `auth.ts`，所有路由自动生效
- **调整路由路径**：修改对应文件中的路由定义，并同步更新 `admin.http`
- **调整数据库操作**：修改 `src/db/` 中对应的函数，admin 路由层通常不需要改动

### 删除管理端点

1. 从对应文件中删除路由处理函数（或删除整个文件）
2. 在 `index.ts` 中移除对应的 `import` 和 `router.use(...)` 行
3. 如有专属数据库操作函数，同步从 `src/db/` 中删除
4. **同步从 `admin.http` 中移除对应示例请求**

## 示例请求

详见项目根目录的 `admin.http` 文件（需安装 VS Code REST Client 扩展）。
