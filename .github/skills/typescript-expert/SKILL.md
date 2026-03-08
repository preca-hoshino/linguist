---
name: typescript-expert
description: >-
  Expert TypeScript guidance covering type-level programming, performance optimization,
  tooling decisions, migration strategies, and Google TypeScript Style Guide compliance.
  Use when writing or reviewing TypeScript code, resolving type errors, configuring
  tsconfig/tooling, or enforcing coding standards and style conventions.
category: framework
risk: unknown
source: community
date_added: "2026-02-27"
---

# TypeScript Expert

Advanced TypeScript expert skill. Load reference files below **only as needed** based on the task.

## Workflow

0. **Route to specialist if needed** — stop and ask user to invoke:
   - Bundler internals (webpack/vite/rollup) → `typescript-build-expert`
   - ESM/CJS migration or circular deps → `typescript-module-expert`
   - Type performance profiling / compiler internals → `typescript-type-expert`

1. **Analyze project setup** — prefer reading `package.json`/`tsconfig.json` directly over shell commands; fall back to:
   ```bash
   npx tsc --version && node -v
   node -e "const p=require('./package.json');console.log(Object.keys({...p.devDependencies,...p.dependencies}).join('\n'))" | grep -E 'biome|eslint|prettier|vitest|jest|turborepo|nx'
   (test -f pnpm-workspace.yaml || test -f lerna.json || test -f nx.json || test -f turbo.json) && echo "Monorepo"
   ```
   Adapt to existing import style, `baseUrl`/`paths`, and project scripts.

2. **Identify problem category**, load the relevant reference file, then apply solution.

3. **Validate** (one-shot only, no watch processes):
   ```bash
   npm run -s typecheck || npx tsc --noEmit
   npm test -s || npx vitest run --reporter=basic --no-watch
   ```

## Reference Index

| File                                               | When to load                                                                                    |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `references/advanced-type-patterns.md`             | Type-level patterns, branded types, conditional types, mapped types, generics, type performance |
| `references/error-diagnosis-and-migration.md`      | Error diagnosis ("cannot be named", module resolution, etc.), JS→TS migration, monorepo setup   |
| `references/linting-debugging-testing.md`          | Biome vs ESLint, type testing, CLI debugging, custom error classes                              |
| `references/config-and-review.md`                  | Strict config, ESM-first, code review checklist, decision trees, resources                      |
| `references/syntax-quick-reference.md`             | Quick syntax reference: primitives, generics, utility types, guards, discriminated unions       |
| `references/utility-types.ts`                      | Ready-to-copy utility types: Brand, Result, Option, DeepReadonly, etc.                          |
| `references/tsconfig-strict.json`                  | Strict tsconfig template                                                                        |
| `references/google-ts-spec-intro.md`               | Google TypeScript 语言规范 — 术语说明与指南导言                                                 |
| `references/google-ts-spec-syntax.md`              | Google TypeScript 语言规范 — 标识符命名、文件编码、注释与文档                                   |
| `references/google-ts-spec-language-features.md`   | Google TypeScript 语言规范 — 可见性、构造函数、类成员、类型转换、迭代、函数                     |
| `references/google-ts-spec-source-organization.md` | Google TypeScript 语言规范 — 模块、导出、导入、代码组织                                         |
| `references/google-ts-spec-type-system.md`         | Google TypeScript 语言规范 — 类型推导、null/undefined、接口、any、泛型                          |
| `references/google-ts-spec-consistency.md`         | Google TypeScript 语言规范 — 代码风格一致性目标与原则                                           |
