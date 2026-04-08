# src/config — 动态配置管理

> 项目总览：参见 [README.md](../README.md)
> 
> 相关模块：[`src/router/README.md`](../router/README.md)（使用方）、[`src/db/README.md`](../db/README.md)（数据源）

## 简介

从 PostgreSQL 加载网关配置（提供商信息、虚拟模型及其后端关联）到内存缓存，提供路由解析能力，并通过 PostgreSQL `LISTEN/NOTIFY` 实现配置热更新。所有模块通过导入单例 `configManager` 使用。

## 目录结构

```
config/
├── manager.ts   # ConfigManager 类（加载、路由解析、LISTEN/NOTIFY 热更新）
└── index.ts     # 导出 configManager 单例
```

## ConfigManager 主要方法

| 方法                                               | 说明                                                                                     |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `loadAll()`                                        | 从数据库全量加载配置到内存 Map（每次行为：完全替换缓存）                                 |
| `resolveAllBackends(virtualModelId, requiredCapabilities?)` | 根据路由策略 + 实时流控状态返回候选后端列表，供 router 填充 `ctx.route` 和 caller 重试逻辑使用 |
| `getAllVirtualModels()`                            | 返回所有已注册的虚拟模型名列表（`string[]`）                                             |
| `getVirtualModelConfig(id)`                        | 按 ID 返回虚拟模型配置（`VirtualModelConfig \| undefined`）                              |
| `startListening()`                                 | 启动专用 LISTEN 连接，监听 `config_channel` 频道                                         |
| `stopListening()`                                  | 关闭 LISTEN 连接（优雅关闭时调用）                                                       |

## 路由策略

| 策略           | 行为                                                             |
| -------------- | ---------------------------------------------------------------- |
| `load_balance` | 按 `weight` 字段加权随机选择单个后端；失败即返回错误，**不重试** |
| `failover`     | 按 `priority` 升序取第一个激活的后端；失败即返回错误，**不重试** |

## 流控感知路由

`resolveAllBackends` 方法在选择后端前会进行两层过滤：

1. **按能力过滤**：后端必须拥有 `requiredCapabilities` 中列出的所有能力才被保留
2. **按流控过滤**：剔除 RPM 或 TPM 任一已达上限的后端（通过 `rateLimiter` 实时检测）

当所有后端均因流控满载不可用时，会记录警告日志供诊断。

## 使用方式

```typescript
import { configManager } from '../config';

// 启动时初始化
await configManager.loadAll();
await configManager.startListening();

// 路由查询（返回按路由策略排序的候选后端列表，长度可能为 0）
const candidates = configManager.resolveAllBackends('deepseek-chat');
// candidates: ResolvedRoute[]（按路由策略排序，长度可能为 0）

// 可选：按请求所需能力过滤后端
const candidatesWithCaps = configManager.resolveAllBackends('deepseek-chat', ['vision', 'tools']);
// 只会返回同时具备 vision 和 tools 能力的后端

// 优雅关闭
await configManager.stopListening();
```

## 内部可靠性

- `loadAll()` 采用"先查后替换"策略：先将查询结果写入临时 Map，查询全部成功后再原子替换内存缓存，避免 DB 查询失败导致缓存被清空
- `startListening()` 在连接断开时自动执行指数退避重连（1s → 2s → 4s → ... → 60s 上限）
- 优雅关闭时通过 `stopping` 标记防止重连竞争

## 新增 / 重构 / 删除向导

### 新增路由策略

1. 在 `manager.ts` 的 `resolveAllBackends` 方法中新增 `case` 分支，实现候选后端选择算法
2. 路由策略类型 `routing_strategy`（字符串联合类型）在 `src/types/gateway.ts` 中更新
3. 如需持久化策略配置，在 `src/db/migrations/` 中添加 SQL 字段，并更新数据库 CHECK 约束

### 重构

- **改变数据库表结构**：修改 `manager.ts` 中的查询语句，并在 `src/db/migrations/` 新增迁移文件
- **扩展 `ResolvedRoute` 字段**：在 `src/types/gateway.ts` 中修改接口，再更新 `manager.ts` 中的赋値逻辑
- **改变热更新机制**：修改 `manager.ts` 中的 `startListening` / `stopListening`，监听频道名在数据库触发器中配置（`src/db/migrations/001_init.sql`）
- **改变重连策略**：修改 `manager.ts` 中的 `scheduleReconnect` 方法参数（退避基数、上限等）

### 删除路由策略

1. 在 `manager.ts` 的 `resolveAllBackends` 方法中移除对应 `case` 分支
2. 在 `src/types/gateway.ts` 中从策略联合类型移除该字符串
3. 检查数据库中是否有使用该策略的虚拟模型配置
