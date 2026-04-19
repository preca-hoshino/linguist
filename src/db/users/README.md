# src/db/users — 用户数据模块

> 父模块：参见 [db/README.md](../README.md)

## 简介

管理用户账号的持久化，包括邮箱密码认证、用户信息 CRUD 和头像存储（BYTEA）。

## 目录结构

```
users/
├── repository.ts   # 所有用户数据访问函数
└── index.ts        # 统一导出
```

## 核心接口

| 函数 | 说明 |
|---|---|
| `findByEmail(email)` | 按邮箱查找用户（含 `password_hash`，用于登录鉴权） |
| `findById(id)` | 按 ID 查找用户（安全字段，不含密码）|
| `listUsers(opts)` | 分页查询用户列表（支持 search/is_active/limit/offset） |
| `countUsers(opts)` | 统计用户总数 |
| `createUser(input)` | 创建新用户（密码哈希使用 `hashPassword()`） |
| `updateUser(id, input)` | 更新用户信息（name/email/is_active/avatar/password 均可独立更新） |
| `deleteUser(id)` | 删除用户（返回 boolean 表示是否实际删除） |
| `getUserAvatarData(id)` | 获取用户头像 BYTEA 数据（供 `/api/users/:id/avatar` 端点使用） |

## 密码安全

- 密码通过 `hashPassword()` 工具（基于 Node.js `crypto.scryptSync`）哈希后存储
- 格式：`scrypt:<salt_hex>:<hash_hex>`
- 登录验证通过 `verifyPassword(plain, stored)` 比对
