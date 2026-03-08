# src/db — 数据库访问模块

# src/db — 数据库访问模块

> 项目总览：参见 [README.md](../README.md)
> 
> 相关模块：[`src/config/README.md`](../config/README.md)（配置存储）、[`src/admin/README.md`](../admin/README.md)（管理 API）

## 简介

管理 PostgreSQL 连接池，提供请求日志和 API Key 的持久化操作，以及统计分析查询和数据库迁移脚本。连接配置通过 `DATABASE_URL` 环境变量指定。

## 目录结构

```
db/
├── client.ts                    # db 查询封装（含自动重试）、createListenClient()、withTransaction()
├── id-generator.ts              # 短 ID 生成器（8 位 hex，查表去重）
├── migrate.ts                   # 迁移脚本入口（npm run db:migrate / db:reset）
├── index.ts                     # 统一再导出（外部模块唯一入口）
│
├── api-keys/                    # API Key 管理模块
│   ├── types.ts                 #   类型定义（ApiKeySummary、ApiKeyCreateResult）
│   ├── cache.ts                 #   内存哈希缓存（loadApiKeyCache / invalidateApiKeyCache / lookupKeyHash）
│   ├── queries.ts               #   CRUD + 轮换 + 验证
│   └── index.ts
│
├── request-logs/                # 请求日志模块
│   ├── types.ts                 #   类型定义 + ENTRY_COLUMNS 查询列常量
│   ├── write.ts                 #   写入操作（markProcessing / markCompleted / markError）
│   ├── read.ts                  #   查询操作（queryRequestLogs / getRequestLogById / deleteRequestLogById）
│   └── index.ts
│
├── stats/                       # 统计分析模块
│   ├── types.ts                 #   所有统计类型定义
│   ├── helpers.ts               #   SQL 表达式构建器、时间工具、过滤子句构建器
│   ├── overview.ts              #   getStatsOverview
│   ├── time-series.ts           #   getStatsTimeSeries（generate_series 填充空 bucket）
│   ├── errors.ts                #   getStatsErrors（单次 CTE 扫描）
│   ├── tokens.ts                #   getStatsTokens
│   ├── today.ts                 #   getStatsToday（今日累计 + 近 1m/5m 实时值）
│   ├── breakdown.ts             #   getStatsBreakdown（分组占比）
│   └── index.ts
│
└── migrations/
    ├── 001_init.sql
    ├── 002_request_logs.sql
    ├── 003_api_keys.sql
    ├── 004_routing_strategy.sql
    ├── 005_stats_fields.sql
    ├── 006_stream_and_timing.sql
    ├── 007_routing_strategy_simplify.sql
    ├── 008_audit_context_refactor.sql
    └── 009_monitoring_indexes.sql
```

## 请求日志操作

| 函数                                        | 说明                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| `markProcessing(ctx: RoutedGatewayContext)` | 创建日志记录，状态 `processing`，fire-and-forget                          |
| `markCompleted(ctx: GatewayContext)`        | 更新状态为 `completed`，记录 token 用量、耗时，存储完整 `gateway_context` |
| `markError(ctx: GatewayContext, err)`       | UPSERT 状态为 `error`（兼容路由前失败场景）                               |
| `queryRequestLogs(query)`                   | 分页查询日志列表（支持 status/model/provider/error_type 等筛选）          |
| `getRequestLogById(id)`                     | 查询单条日志详情（含完整 `gateway_context` 审计快照）                     |
| `deleteRequestLogById(id)`                  | 删除单条日志记录                                                          |

### 审计数据存储方式

`gateway_context` 为 JSONB 列，是审计日志的**唯一完整数据源**。四次 HTTP 交换的头部和请求/响应体均内嵌其中：

```
gateway_context.audit.userRequest.headers / .body
gateway_context.audit.providerRequest.headers / .body
gateway_context.audit.providerResponse.headers / .body
gateway_context.audit.userResponse.headers / .body
```

## API Key 缓存

`api-keys/cache.ts` 维护内存 Map（`key_hash → { id, expiresAt }`），避免每次鉴权都查询数据库：

- **懒加载**：首次调用 `lookupKeyHash()` 时自动触发 `loadApiKeyCache()`
- **缓存失效**：写操作（create / update / rotate / delete）执行后自动调用 `invalidateApiKeyCache()`
- **外部刷新**：`loadApiKeyCache()` / `invalidateApiKeyCache()` 通过 `index.ts` 导出，供 LISTEN/NOTIFY 回调主动调用

## 统计分析

`stats/helpers.ts` 封装所有可复用的 SQL 构建工具：

| 导出                                                             | 说明                                               |
| ---------------------------------------------------------------- | -------------------------------------------------- |
| `LATENCY_EXPR` / `TTFT_EXPR` / `ITL_EXPR`                        | 无别名的延迟 SQL 表达式常量                        |
| `latencyExpr(alias?)` / `ttftExpr(alias?)`                       | 带表别名的延迟表达式函数（用于联表查询）           |
| `buildTimeFilter(params, idx)`                                   | 构建时间过滤子句（支持 range 和 from/to 两种模式） |
| `buildDimensionFilter(...)` / `buildDimensionFilterAliased(...)` | 构建维度过滤子句（带/不带表别名）                  |
| `buildBucketExpr(interval)`                                      | 生成时间分桶 SQL 表达式                            |
| `autoInterval(range)` / `autoIntervalForDates(from, to)`         | 自动选择时间粒度                                   |

## 数据库命令

```bash
npm run db:migrate   # 按顺序执行所有迁移文件（安全，表已存在则跳过）
npm run db:reset     # ❗ 删除所有表并重建（仅用于本地开发！）
```

## 新增 / 重构向导

### 新增数据库迁移

1. 在 `src/db/migrations/` 下按序号新建 SQL 文件（如 `010_xxx.sql`）
2. 使用 `CREATE TABLE IF NOT EXISTS` 保证幂等性
3. 开发环境执行 `npm run db:reset`，生产环境手动执行新文件

### 新增数据库访问函数

1. 在对应子目录（`api-keys/` / `request-logs/` / `stats/`）内新建或修改文件
2. 在子目录的 `index.ts` 中导出
3. 在 `src/db/index.ts` 中追加再导出，保持外部入口统一

### 新增业务模块

若需新增独立业务模块（如 `users/`）：

1. 在 `src/db/` 下新建子目录，包含 `types.ts`、业务文件和 `index.ts`
2. 在 `src/db/index.ts` 中追加导出
3. 在 `migrations/` 下新建对应迁移文件

### 重构表结构

- 新建迁移文件执行 `ALTER TABLE`，同步更新查询文件中的 SQL
- 调整连接池参数：修改 `client.ts`，支持 `DB_POOL_MAX` 环境变量控制最大连接数
