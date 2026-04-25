---
trigger: always_on
---

## 项目技术栈约定

本项目为 **Node.js + TypeScript + Express** 后端网关，使用以下工具链，agent 须严格遵守：

- **包管理**：`npm`，禁止使用 yarn / pnpm
- **格式化 + Lint**：Biome + ESLint，通过 `npm run check` 统一执行，禁止手动格式化
- **类型检查**：`tsc --noEmit`，禁止使用 `@ts-ignore`（仅允许在有SDK强制原因时使用`@ts-expect-error`并附注释说明）
- **依赖扫描**：knip，引入新依赖前须确认未产生未使用导出
- **测试框架**：Jest，测试文件放在对应模块的 `__tests__/` 子目录下

---

## 目录结构规范

### 核心模块分层（严格遵守，不得越层引用）

```
src/
├── api/            → 仅负责 HTTP 端点注册和 model/API Key 提取，不含业务逻辑
├── admin/          → 管理 API，每种资源独立文件，禁止在一个文件中混合多个资源路由
├── config/         → 动态配置，唯一允许维护内存缓存的配置层
├── db/             → 数据库访问层，按资源类型拆分子目录（禁止在 admin/ 或 api/ 中写裸 SQL）
├── mcp/            → MCP 网关，providers/ 和 virtual/ 两个子模块严格分离
├── middleware/     → 中间件，按 common/mcp/model 三层组织，禁止在此层直接操作数据库
├── model/http/     → 核心流程（app/ router/ users/ providers/），禁止在此层直接操作数据库
├── types/          → 纯类型定义，禁止包含任何运行时逻辑
└── utils/          → 纯工具函数，禁止依赖项目内部模块（types/ 除外）
```

### 新增模块时必须

1. 在对应层的 `index.ts` 中统一再导出，保持外部入口单一
2. 同步在 `src/db/sql/migrations/` 下新建迁移文件（涉及数据库变更时），命名格式：`NN_描述.sql`，内容使用 `IF NOT EXISTS` 保证幂等
3. 在模块目录下同步创建或更新 `README.md`，格式参照现有模块文档

---

## 代码编写规范

### 命名

| 场景 | 规范 | 示例 |
| --- | --- | --- |
| 文件名 | kebab-case | `error-mapping.ts`、`base-client.ts` |
| 类名 | PascalCase | `McpProviderClient`、`GatewayError` |
| 函数 / 变量 | camelCase | `handleMcpSseConnect`、`apiKeyAuth` |
| 数据库字段 | snake_case | `virtual_mcp_id`、`is_active` |
| 提供商 kind 标识 | 全小写 | `'deepseek'`、`'copilot'`、`'volcengine'` |
| 分支命名 | 参照 CONTRIBUTING.md | `feat/xxx`、`fix/xxx`、`docs/xxx` |

### 错误处理

- 捕获到的错误**必须**通过 `GatewayError` 抛出（含 `statusCode`、`errorCode`、`message` 三要素）
- 禁止在路由处理函数中直接 `res.send(500)`，统一通过 `handleAdminError(error, res)` 或 `next(err)` 处理
- 对外暴露的错误信息不得泄露内部实现细节（提供商原始错误记录在 `providerDetail` 字段，不直接透传）
- 所有 `catch (err)` 必须处理 `err instanceof Error` / `String(err)` 两种情况，禁止 `catch (err: any)`

### 日志

- 每个模块自行通过 `createLogger('ModuleName', logColors.xxx)` 创建 logger，禁止引用其他模块的 logger 实例
- 日志消息使用**结构化对象**作为第一参数，描述字符串作为第二参数：`logger.info({ requestId, appId }, 'Request routed')`
- 禁止在生产路径上使用 `console.log`，统一使用 winston logger

### 类型

- 禁止使用 `any`，类型不确定时使用 `unknown` 并在使用前做类型收窄
- 接口类型定义统一放在 `src/types/` 或对应模块的 `types.ts` 文件中
- 数据库查询结果必须通过泛型参数指定返回类型：`db.query<MyRowType>(...)`

---

## 数据库操作规范

- **连接池**：禁止绕过 `db` 客户端直接创建连接；需要事务时使用 `withTransaction()` 封装
- **动态 SQL**：更新操作统一使用 `buildUpdateSet()`，批量插入使用 `buildBatchInsert()`，禁止手工拼接 SET 子句
- **分页**：
  - 管理 API（`admin/`）统一使用 **offset 分页**（`limit` + `offset`）
  - 应用级 API（`apps/`、`config/`）使用 **游标分页**（`starting_after`）
- **迁移**：新建迁移文件后须在 PR 描述中注明，并确认 `npm run db:migrate` 可幂等执行（不得破坏已有数据）

---

## 新增业务实体的完整流程

新增一个业务实体（如新的资源类型）须按以下顺序完成，每步通过 `npm run check` 后再原子提交：

1. **数据库层**：在 `src/db/sql/migrations/` 添加迁移文件；在 `src/db/<entity>/` 添加 `types.ts`、查询文件、`index.ts`；在 `src/db/index.ts` 追加导出
2. **类型层**（如需）：在 `src/types/` 添加跨模块共享类型
3. **管理 API 层**：在 `src/admin/<entity>.ts` 实现 CRUD 路由；在 `src/admin/index.ts` 挂载
4. **文档**：在 `src/db/<entity>/README.md` 和 `src/admin/README.md` 中同步更新
5. **测试**：在 `src/db/<entity>/__tests__/` or `src/admin/__tests__/` 添加单元测试

---

## 新增 AI 提供商的完整流程

1. 在 `src/model/http/providers/<kind>/` 下创建：`index.ts`（导出 `<Kind>Plugin: ProviderPlugin`）、`error-mapping.ts`、`chat/client.ts`、`chat/request/index.ts`、`chat/response/index.ts`、`chat/response/stream.ts`（如支持流式）
2. 在 `src/model/http/providers/index.ts` 中注册插件
3. 在 `src/model/http/providers/<kind>/README.md` 中说明协议差异和认证方式
4. 在 `src/model/http/providers/README.md` 中的目录树和"已实现提供商"表格中补充新条目

---

## 大模型网关对话数据流规范

本项目作为多模型网关，核心原则是**内外解耦、严格适配**。所有对话请求和响应必须强制通过内部统一数据结构（`InternalChatRequest` / `InternalChatResponse`）中转，禁止"客户端-提供商"的属性直连透传。

### 统一数据类型约束
- **类型纯粹性**：内部类型中**禁止**包含任何与特定提供商或用户协议绑定的私有字段（如 `reasoning_effort`）。
- **模型隔离**：内部请求对象**不包含** `model` 字段，路由与模型选择统一由底层逻辑挂载至上下文 (`ModelHttpContext`)。
- **严格格式化**：多模态内容、工具调用（`tool_calls`）、函数声明等复杂对象，必须强制收敛为项目的标准结构。

### 用户侧适配器要求 (User Adapters)
- **入口全量消化**：必须在请求解析入口将客户端的所有协议细节**完全消化**并映射至统一内部类型。
- **消灭透传通道**：用户传入的特定协议参数（如 `reasoning_effort`），必须在适配器层转化为标准内部概念（如计算为 `ThinkingConfig.budget_tokens`），**绝不允许**将原始字段直接透传进内部总线。
- **强校验屏障**：在此层完成所有参数的取值范围与类型校验，非法输入必须在到达网络层之前以 400 错误拦截。

### 提供商适配器要求 (Provider Adapters)
- **单向依赖**：构建请求体时，**只允许**读取 `InternalChatRequest` 规范中定义的标准字段。
- **特性反向推断**：若提供商需要特定参数（如火山引擎的 `reasoning_effort`），必须通过内部通用参数（如 `budget_tokens / max_tokens` 比率）**动态推断**生成，禁止尝试直读可能泄漏的同名字段。
- **安全对象构建**：诸如 `response_format` 之类的配置对象，禁止通过整体引用赋值进行传递，必须逐字段提取并重新组装提供商所期望的底层类型。

---

## MCP 模块规范

- **外部标识**：虚拟 MCP 统一通过 `name`（用户自定义，无空格，全局唯一）寻址，内部操作使用 `id`，禁止对外暴露 `id`
- **SSE 路由**：MCP 客户端通过 `X-Mcp-Name` header 指定目标（与模型侧用 `body.model` 对称）
- **工具白名单**：工具名称白名单保存在 `virtual_mcp_servers.config.tools[]` JSONB 字段，不得硬编码
- **日志**：所有 `tools/list` 和 `tools/call` 调用（含错误）必须通过 `insertMcpLog()` 异步写入，不得跳过

---

## 文档规范

- 每个 `src/` 子目录（含二级）须有对应的 `README.md`
- README 格式须包含：顶部父模块链接、简介、目录结构（代码块）、核心接口/端点表格、新增/重构/删除向导
- 新增端点或模块文件后，须**同步更新**对应的 README（不得发起 PR 时文档与实现不一致）
- 提供商端点示例须同步更新项目根目录的 `admin.http` 文件
