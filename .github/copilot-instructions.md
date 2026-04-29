# Linguist — LLM Gateway 项目规范

## 技术栈
Node.js + Express 5 + TypeScript (CommonJS) + PostgreSQL (raw SQL) + Winston

## 代码风格
- 使用 `@/*` 绝对路径导入，禁止相对路径 `../../`
- 所有 import 按层级分组：外部依赖 → 内部模块（config → db → middleware → model → types → utils）
- 命名规范：文件名 kebab-case，函数 camelCase，类型/接口 PascalCase
- 类型使用 `interface` 定义数据结构，`type` 定义联合/别名

## 错误处理
- **所有可预期的业务错误必须抛出 `GatewayError`**：`throw new GatewayError(statusCode, errorCode, message)`
- `errorCode` 为机器可读标识符，必须从以下已定义集合中选择（禁止随意造新码）：
  - **400**：`invalid_request`、`invalid_range`、`invalid_dimension`、`missing_id`、`invalid_interval`、`invalid_group_by`、`unknown_format`、`capability_not_supported`、`model_type_mismatch`、`stream_not_supported`、`invalid_model`、`bad_request`
  - **401**：`unauthorized`、`invalid_api_key`
  - **402**：`insufficient_balance`
  - **403**：`forbidden`
  - **404**：`not_found`、`model_not_found`
  - **409**：`conflict`
  - **500**：`internal_error`、`route_error`
  - **503**：`no_backend_available`
- 捕获未知错误时参数类型必须为 `unknown`，用 `instanceof GatewayError` 区分
- 不要在中间件内部吞掉错误，统一在 endpoint handler 层用 `handleError()` 处理

## 日志规范
- 使用 Winston `createLogger('ServiceName', color)` 创建彩色日志
- 必须使用结构化日志：`logger.info({ requestId, ip }, '描述信息')`
- 日志级别：debug（调试细节）、info（关键流程节点）、warn（GatewayError）、error（未预期错误）
- 错误日志传入 `{ err }` 以自动提取 stack trace

## 数据库
- 使用 `db.query<T>(sql, params[])` 进行参数化查询，禁止拼接 SQL 字符串
- 查询用户表必须使用安全列名常量（`SAFE_COLUMNS`），避免 `SELECT *` 泄露敏感字段
- 事务使用 `withTransaction()` 工具函数
- 迁移文件放在 `src/db/migrations/`，必须幂等（IF NOT EXISTS / IF EXISTS）

## 中间件与请求处理
- 自定义中间件签名为 `async (ctx: ModelHttpContext) => void`，通过修改 ctx 传递数据
- 使用 `applyMiddlewares(ctx, middlewares[])` 顺序执行中间件链
- Admin 路由使用 JWT 鉴权，通过 `res.locals.userId` 传递用户身份
- 用户 API 路由使用 API Key 鉴权

## API 设计
- 支持三种 API 格式：OpenAI 兼容、Anthropic Messages、Google Gemini
- 每种格式有独立的 auth 提取、请求解析、响应构建模块
- 响应通过 `handleError()` 统一生成格式特定的错误 JSON

## 测试
- 使用 Jest + ts-node，测试文件与源文件同目录（`*.test.ts`）
- Mock 使用 `jest.mock('@/module', ...)` ，类型断言使用 `jest.fn<ReturnType, Args>()`
- 集成测试直接 mock Express Response 对象

## 构建与运行
```bash
npm run dev          # 开发模式（ts-node 热加载）
npm run build        # 构建（tsc + tsc-alias + 复制迁移文件）
npm run check        # 全量检查（format + lint + types + deps + test）
npm run db           # 运行数据库迁移
```
