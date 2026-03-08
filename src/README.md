# src — 网关后端核心

## 简介

Lingist 网关的后端核心代码，基于 Node.js + TypeScript + Express 构建。各模块职责清晰，通过 `GatewayContext` 贯穿整个请求生命周期。

> **概念总览**：参见项目根目录 [README.md](../README.md)

---

## 模块概览

| 模块                                  | 说明                                      | 详细文档                                     |
| ------------------------------------- | ----------------------------------------- | -------------------------------------------- |
| [`app/`](app/README.md)               | 核心流程编排，处理 Chat 和 Embedding 请求 | [app/README.md](app/README.md)               |
| [`api/`](api/README.md)               | 用户 API 格式路由，提取 model 和 API Key  | [api/README.md](api/README.md)               |
| [`admin/`](admin/README.md)           | 管理 API，支持配置管理和统计查询          | [admin/README.md](admin/README.md)           |
| [`config/`](config/README.md)         | 动态配置管理，内存缓存 + 热更新           | [config/README.md](config/README.md)         |
| [`db/`](db/README.md)                 | 数据库访问，连接池 + 操作封装             | [db/README.md](db/README.md)                 |
| [`router/`](router/README.md)         | 虚拟模型路由解析                          | [router/README.md](router/README.md)         |
| [`middleware/`](middleware/README.md) | 中间件链执行器                            | [middleware/README.md](middleware/README.md) |
| [`users/`](users/README.md)           | 用户格式适配器（外部 → 内部）             | [users/README.md](users/README.md)           |
| [`providers/`](providers/README.md)   | 提供商适配器（内部 → 厂商格式）           | [providers/README.md](providers/README.md)   |
| [`types/`](types/README.md)           | 内部统一类型定义                          | [types/README.md](types/README.md)           |
| [`utils/`](utils/README.md)           | 公用工具函数                              | [utils/README.md](utils/README.md)           |

---

## 核心概念

### GatewayContext 贯穿全生命周期

```
创建 ctx → 用户适配(填充 ctx.request) → 请求中间件(ctx)
  → 路由(填充 ctx.route) → 提供商请求适配(ctx.request + ctx.route.model)
  → 提供商调用 → 提供商响应适配(填充 ctx.response)
  → 响应中间件(ctx) → 用户响应适配(从 ctx 组装) → 发送
```

### 双层适配器模式

- **用户适配器** (`users/`)：转换客户端格式 ↔ 内部类型
- **提供商适配器** (`providers/`)：转换内部类型 ↔ 厂商 API 格式

### 三层模型路由

```
VirtualModel (用户请求的 model)
  ↓ 路由
ProviderModel (提供商侧真实模型)
  ↓ 调用
Provider (DeepSeek / Gemini / 火山引擎等)
```

---

## 快速导航

- **新增 AI 提供商**：[`providers/README.md`](providers/README.md)
- **新增用户 API 格式**：[`users/README.md`](users/README.md)、[`api/README.md`](api/README.md)
- **新增中间件**：[`middleware/README.md`](middleware/README.md)
- **管理 API 开发**：[`admin/README.md`](admin/README.md)
- **数据库操作**：[`db/README.md`](db/README.md)