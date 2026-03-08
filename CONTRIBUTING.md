# 贡献指南 (Contributing Guide)

> 项目概述、快速启动和 API 文档请参见 [README.md](README.md)。

## 开发流程

### 环境准备

依赖安装与服务启动参见 [README.md — 快速开始](README.md#快速开始)。

### 提交前检查

在提交代码前，请务必按顺序运行以下命令以确保代码质量：

```bash
npm run type-check   # TypeScript 类型检查（零错误才可提交）
npm run lint         # ESLint 检查（--max-warnings 0，不允许任何警告）
npm run format       # Prettier 格式化（自动修复）
npm test             # 运行 Jest 测试用例
```

**重要**：ESLint 检查必须通过零错误零警告，否则无法合并。若需自动修复格式问题，使用：
```bash
npm run lint:fix     # 自动修复 ESLint 错误
npm run format       # 自动修复代码格式
```

### 扩展项目

- **新增 AI 提供商**：参见 [`src/providers/README.md`](src/providers/README.md)
- **新增用户 API 格式**：参见 [`src/users/README.md`](src/users/README.md) + [`src/api/README.md`](src/api/README.md)
- **新增中间件**：参见 [`src/middleware/README.md`](src/middleware/README.md)
- **管理 API 变更**：修改 `src/admin/` 后必须同步更新 `admin.http`

---

## 提交规范 (Commit Convention)

提交信息应遵循以下格式：

```
[Type] 描述信息
```

**Type 类型列表：**

| Type      | 用途                   |
| --------- | ---------------------- |
| `[Add]`   | 新增功能               |
| `[Fix]`   | Bug 修复               |
| `[Ref]`   | 重构（不改变外部行为） |
| `[Del]`   | 删除代码或文件         |
| `[Merge]` | 分支合并记录           |

---

## 🌿 分支模型与镜像标签策略

本项目采用 **Git Flow 分支模型** 并配合 **语义化版本标签**，通过 GitHub Actions 自动化构建和镜像发布流程。

### 分支说明

| 分支类型  | 命名示例      | 说明                                                                                   |
| --------- | ------------- | -------------------------------------------------------------------------------------- |
| `master`  | `master`      | 默认分支，始终对应最新稳定版本。只允许合并，不接受直接提交。**仅此分支可打版本标签。** |
| `develop` | `develop`     | 主要开发集成分支，所有功能、重构、修复分支都从此切出，并通过 PR 合并回来。             |
| `feat/*`  | `feat/login`  | 新功能开发分支，从 `develop` 切出，完成后合并回 `develop`。                            |
| `ref/*`   | `ref/storage` | 代码重构分支，从 `develop` 切出，完成后合并回 `develop`。                              |
| `fix/*`   | `fix/bug-123` | 普通 bug 修复分支（非紧急），从 `develop` 切出，完成后合并回 `develop`。               |

### 版本标签与镜像标签

**正式发布标签**：`v<major>.<minor>.<patch>`，例如 `v1.2.3`。

⚠️ **重要**：**只有 `master` 分支上的提交才能打版本标签**。其他分支（包括 `develop`）都禁止打标签。标签打错后无法直接删除远程标签，必须通过团队负责人处理。

**Docker 镜像标签策略**：

| 触发条件            | 镜像标签                 | 说明                                         |
| ------------------- | ------------------------ | -------------------------------------------- |
| 推送 `v1.2.3` 标签  | `1.2.3`、`1.2`、`latest` | 版本镜像，其中 `latest` 始终指向最新稳定版本 |
| 推送到 feature 分支 | 无镜像推送               | 仅运行测试和构建验证，不推送镜像             |

> **注意**：仅在版本标签时推送镜像。`feat/*`、`ref/*`、`fix/*` 分支仅运行测试和构建验证，避免镜像仓库被临时分支污染。

### 🐳 轻量化 Docker 构建（Node.js Alpine）

为获得最轻量的生产镜像，项目使用 `node:22-alpine` 作为基础镜像，并采用 **多阶段构建** 进一步减小镜像体积。有关详细信息，请参见项目根目录的 `Dockerfile`。

**多阶段构建优点**：
- 最终镜像仅包含运行时所需的文件和依赖，不含构建工具链，体积大幅减小
- Alpine 基础镜像仅几 MB，加上 Node.js 和必要模块，依然保持轻量

### 🤖 GitHub Actions CI/CD 工作流

所有分支和标签推送都会自动触发 GitHub Actions 工作流（`.github/workflows/ci.yml`），执行以下任务：

| 任务             | 触发条件                   | 行为                                                                |
| ---------------- | -------------------------- | ------------------------------------------------------------------- |
| **test**         | 所有分支和标签             | 运行类型检查、lint 检查、Jest 测试                                  |
| **build-verify** | `feat/*`、`ref/*`、`fix/*` | 验证 Docker 构建成功（`docker build`，不推送）                      |
| **release**      | `v*.*.*` 标签              | 构建并推送版本镜像（`1.2.3`、`1.2`、`latest`），创建 GitHub Release |

有关详细实现，请参见 `.github/workflows/ci.yml`。

### 🚀 全流程实操示例

#### 日常功能开发

1. 从 `develop` 创建特性分支
   ```bash
   git checkout develop
   git pull origin develop
   git checkout -b feat/user-profile
   ```

2. 编写代码并提交
   ```bash
   git add .
   git commit -m "[Add] 用户资料页面"
   git push origin feat/user-profile
   ```

3. GitHub Actions 自动化流程：
   - ✅ 运行 type-check、lint、test 验证
   - ✅ 通过 `build-verify` 验证 Docker 构建（不推送镜像）
   - ✅ 确保分支可合并

4. 完成开发后，提交 Pull Request 到 `develop`，审核通过后合并至发布分支
   ```bash
   # 在 GitHub 上合并 PR，或本地合并：
   git checkout develop
   git pull origin develop
   git merge --no-ff feat/user-profile
   git push origin develop
   ```

#### 发布新版本

1. 确保 `develop` 包含所有待发布的功能

2. 创建 Pull Request 到 `master`
   ```bash
   git checkout develop
   git pull origin develop
   git checkout master
   git pull origin master
   git merge --no-ff develop
   git push origin master
   ```

3. 审核通过，合并到 `master`

4. **在本地 `master` 分支打标签**（仅 `master` 分支可打标签）
   ```bash
   git checkout master
   git pull origin master
   # 确认当前分支是 master
   git branch
   # 打标签
   git tag v1.2.0
   git push origin v1.2.0
   ```
   
   ⚠️ **检查清单**：
   - 确保当前分支是 `master`（`git branch` 显示 `* master`）
   - 确保推送前已拉取最新代码（`git pull origin master`）
   - 标签版本号遵循语义化版本规范（`v主版本.次版本.修订版本`）
   - 一旦推送标签到远程就无法撤回，请仔细核实

5. GitHub Actions 自动化流程：
   - ✅ 运行 `npm test` 验证版本正确性
   - ✅ 构建 Docker 镜像，推送标签：`1.2.0`、`1.2`、`latest`
   - ✅ 创建 GitHub Release 并生成发布说明
