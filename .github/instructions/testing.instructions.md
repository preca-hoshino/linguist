---
description: '测试规范 — Jest、Mock 策略、集成测试、覆盖率'
applyTo: 'src/**/*.test.ts, src/**/*.spec.ts, tests/**/*.ts'
---

# 测试规范

## 概述
本文件定义 Linguist Gateway 的测试规范，基于 Jest + ts-node，覆盖单元测试和集成测试的编写模式、Mock 策略和覆盖率要求。

---

## 核心规则

### 1. 测试文件放置

测试文件 **必须** 与源文件同目录，以 `.test.ts` 结尾：

```
src/utils/errors.ts
src/utils/__tests__/errors.test.ts        ← 单元测试

src/admin/auth.ts
src/admin/__tests__/auth.test.ts          ← 单元测试

tests/integration/setup.ts                  ← 集成测试辅助
tests/e2e/                                  ← E2E 测试
tests/helpers/                              ← 测试工具函数
tests/mocks/                                ← Mock 工厂
```

### 2. Mock 模块 — `jest.mock('@/module', ...)`

```typescript
// ✅ 标准 Mock 模式
jest.mock('@/utils', () => ({
  ...jest.requireActual<typeof import('@/utils')>('@/utils'),
  verifyToken: jest.fn(),
  createLogger: jest.fn(() => ({
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
  })),
}));
```

**Mock 函数类型断言**：

```typescript
// ✅ 明确类型断言
(verifyToken as jest.Mock).mockReturnValue(null);
(db.query as jest.Mock).mockResolvedValue({ rows: [], rowCount: 0 });
```

```typescript
// ❌ 避免 — 无类型断言的 mock
const verifyToken = jest.fn();  // any
```

### 3. 集成测试 — Mock Express Response

集成测试中 mock Express `Response` 对象：

```typescript
interface MockRes {
  statusCode: number;
  body: unknown;
  status: (code: number) => MockRes;
  json: (data: unknown) => MockRes;
}

function createMockRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: null,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: unknown) {
      res.body = data;
      return res;
    },
  };
  return res;
}

// 使用
const res = createMockRes();
handleError(new GatewayError(404, 'model_not_found', '...'), res as unknown as Response);
expect(res.statusCode).toBe(404);
expect(res.body).toEqual({
  error: { code: 'model_not_found', message: '...', type: 'gateway_error' },
});
```

### 4. 测试结构 — AAA 模式 + `describe`/`it`

```typescript
describe('GatewayError', () => {
  it('should create an error with statusCode, errorCode, and message', () => {
    // Arrange
    const statusCode = 400;
    const errorCode = 'invalid_model';
    const message = 'Model not found';

    // Act
    const err = new GatewayError(statusCode, errorCode, message);

    // Assert
    expect(err).toBeInstanceOf(GatewayError);
    expect(err.statusCode).toBe(statusCode);
    expect(err.errorCode).toBe(errorCode);
    expect(err.message).toBe(message);
  });

  it('should preserve prototype chain for instanceof checks', () => {
    const err = new GatewayError(500, 'internal_error', 'Something went wrong');
    expect(err instanceof GatewayError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });
});
```

**测试命名规范**：`should <预期行为> [when <条件>]`

### 5. 数据库测试 — 事务回滚

涉及 DB 的单元测试使用 `withTransaction()` + 回滚策略，避免污染数据库：

```typescript
import { withTransaction } from '@/db/client';

describe('User queries', () => {
  it('should create and retrieve a user within a rolled-back transaction', async () => {
    await withTransaction(async (executor) => {
      // 在事务中执行测试
      const inserted = await executor.query(
        'INSERT INTO users (name) VALUES ($1) RETURNING id',
        ['test-user']
      );
      const fetched = await executor.query(
        'SELECT * FROM users WHERE id = $1',
        [inserted.rows[0].id]
      );
      expect(fetched.rows[0].name).toBe('test-user');
      // 事务自动回滚，不提交到数据库
      throw new Error('Rollback trigger');
    }).catch(() => {
      // 预期回滚
    });
  });
});
```

### 6. `beforeEach` / `afterEach` 清理

```typescript
describe('adminAuth middleware', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    mockRequest = {
      headers: {},
      ip: '127.0.0.1',
      path: '/api/admin',
      method: 'GET',
    };
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      locals: {},
    };
    mockNext = jest.fn() as NextFunction;
    process.env.JWT_SECRET = 'test-secret';
    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.JWT_SECRET;
  });
});
```

### 7. 运行测试命令

```bash
npm run check       # 全量检查（format + lint + types + deps + test）
npx jest            # 单独运行测试
npx jest --coverage # 带覆盖率报告
```

---

## 常见陷阱

| 陷阱                               | 正确做法                                                          |
| ---------------------------------- | ----------------------------------------------------------------- |
| Mock 后忘记 `jest.clearAllMocks()` | 在 `beforeEach` 中调用 `jest.clearAllMocks()`                     |
| `jest.fn()` 没有类型参数           | 使用 `jest.fn<ReturnType, Args>()` 或 `as jest.Mock`              |
| 集成测试中直接使用真实 DB          | 使用 `withTransaction()` + 回滚，或在测试 CI 中使用独立测试数据库 |
| 测试文件与源文件分离               | 测试必须与源文件同目录，以 `.test.ts` 结尾                        |
| 环境变量污染                       | 在 `afterEach` 中清理 `process.env` 的修改                        |
| 测试命名不清晰                     | 遵循 `should <预期> [when <条件>]` 模式                           |

---

## 项目参考

- `src/utils/__tests__/errors.test.ts` — GatewayError 单元测试标准范例
- `src/admin/__tests__/auth.test.ts` — Mock 模块 + Express 集成测试范例
- `src/db/__tests__/client.test.ts` — 数据库测试范例
- `tests/mocks/` — Mock 工厂函数
- `tests/helpers/` — 测试辅助工具
- `jest.config.js` — Jest 配置
