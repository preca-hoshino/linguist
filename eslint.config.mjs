import { defineConfig } from 'eslint/config';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

import boundaries from 'eslint-plugin-boundaries';

import biome from 'eslint-config-biome';

export default defineConfig([


  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'boundaries': boundaries,
    },
    settings: {
      'boundaries/elements': [
        { type: 'admin', pattern: 'src/admin/**/*' },
        { type: 'api', pattern: 'src/api/**/*' },
        { type: 'app', pattern: 'src/app/**/*' },
        { type: 'config', pattern: 'src/config/**/*' },
        { type: 'db', pattern: 'src/db/**/*' },
        { type: 'middleware', pattern: 'src/middleware/**/*' },
        { type: 'providers', pattern: 'src/providers/**/*' },
        { type: 'router', pattern: 'src/router/**/*' },
        { type: 'types', pattern: 'src/types/**/*' },
        { type: 'users', pattern: 'src/users/**/*' },
        { type: 'utils', pattern: 'src/utils/**/*' }
      ]
    },
    rules: {
      // 基础：strict-type-checked 规则集
      ...tsPlugin.configs['strict-type-checked'].rules,




      // ===== 类型安全 =====
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-enum-comparison': 'error',

      // ===== 严格函数签名 =====
      '@typescript-eslint/explicit-function-return-type': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',

      // ===== 变量与参数 =====

      // ===== 类型断言与转换 =====
      '@typescript-eslint/restrict-template-expressions': ['error', {
        allowNumber: true,
        allowBoolean: false,
        allowAny: false,
        allowNullish: false,
        allowRegExp: false,
        allowNever: false,
      }],

      '@typescript-eslint/consistent-type-assertions': ['error', {
        assertionStyle: 'as',
        objectLiteralTypeAssertions: 'never',
      }],
      '@typescript-eslint/strict-boolean-expressions': ['error', {
        allowNullableBoolean: true,
        allowNullableString: false,
        allowNullableNumber: false,
        allowNullableObject: true,
        allowAny: false,
      }],

      // ===== Promise 与异步 =====
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/return-await': ['error', 'always'],
      '@typescript-eslint/promise-function-async': 'error',

      // ===== Import 与模块 =====
      '@typescript-eslint/consistent-type-imports': ['error', {
        prefer: 'type-imports',
        fixStyle: 'separate-type-imports',
      }],
      '@typescript-eslint/consistent-type-exports': ['error', {
        fixMixedExportsWithInlineTypeSpecifier: true,
      }],

      // ===== 类与继承 =====
      '@typescript-eslint/no-extraneous-class': 'error',
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/explicit-member-accessibility': ['error', {
        accessibility: 'explicit',
        
      }],

      // ===== 代码质量 =====
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/no-unnecessary-type-arguments': 'error',
      '@typescript-eslint/no-unnecessary-boolean-literal-compare': 'error',
      '@typescript-eslint/no-redundant-type-constituents': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',
      '@typescript-eslint/no-confusing-void-expression': ['error', {
        ignoreArrowShorthand: false,
        ignoreVoidOperator: false,
      }],
      '@typescript-eslint/require-array-sort-compare': 'error',
      // 'prefer-promise-reject-errors' 原生版本已由 Biome 覆盖，仅保留 TS 类型感知版本
      'prefer-promise-reject-errors': 'off',
      '@typescript-eslint/prefer-promise-reject-errors': 'error',
      '@typescript-eslint/no-unsafe-unary-minus': 'error',
      '@typescript-eslint/no-invalid-void-type': 'error',
      '@typescript-eslint/method-signature-style': ['error', 'property'],

      // ===== 命名约定 =====
      '@typescript-eslint/naming-convention': ['error',
        { selector: 'default', format: ['camelCase'], leadingUnderscore: 'allow' },
        { selector: 'variable', format: ['camelCase', 'UPPER_CASE'], leadingUnderscore: 'allow' },

        { selector: 'variable', modifiers: ['destructured'], format: null },
        { selector: 'typeLike', format: ['PascalCase'] },
        { selector: 'enumMember', format: ['UPPER_CASE', 'PascalCase'] },

        { selector: 'property', format: null },
        { selector: 'parameter', format: ['camelCase'], leadingUnderscore: 'allow' },
      ],

      // ===== 通用 JS/TS 最佳实践 =====
      // 以下规则由 ESLint TypeScript 扩展版本替代（需关闭基础版以防冲突）
      'no-implied-eval': 'off',
      '@typescript-eslint/no-implied-eval': 'error',
      'no-throw-literal': 'off',
      '@typescript-eslint/only-throw-error': 'error',
      // 以下规则已由 Biome 覆盖（style.useConst / style.noParameterAssign / suspicious.noVar），
      // ESLint 关闭避免双重报告，专注类型感知与架构边界职责
      'prefer-const': 'off',
      'no-var': 'off',
      'no-param-reassign': 'off',
      'no-return-assign': 'off',

      'boundaries/dependencies': ['error', {
        default: 'allow',
        rules: [
          { from: { type: 'types' }, disallow: [{ to: { type: ['admin', 'api', 'app', 'config', 'db', 'middleware', 'providers', 'router', 'users', 'utils'] } }], message: 'Type 层是最高抽象，不能反向依赖其他业务类型的模块。' },
          { from: { type: 'utils' }, disallow: [{ to: { type: ['admin', 'api', 'app', 'db', 'middleware', 'providers', 'router', 'users'] } }], message: 'Utils 作为纯底层模块，不能去反向依赖业务代码或者领域模型。' },
          { from: { type: 'config' }, disallow: [{ to: { type: ['admin', 'api', 'app', 'db', 'middleware', 'providers', 'router', 'users'] } }], message: 'Config 层负责基础环境，不应包含具体的业务逻辑或数据库实例。' },
          { from: { type: 'db' }, disallow: [{ to: { type: ['admin', 'api', 'app', 'middleware', 'providers', 'router', 'users'] } }], message: 'DB 是基础设施层，不得反向依赖应用路由或外部供应商逻辑。' },
          { from: { type: 'users' }, disallow: [{ to: { type: ['admin', 'api', 'app', 'db', 'middleware', 'providers', 'router'] } }], message: 'Users 格式适配器层，禁止依赖提供者网络请求、数据库或其他高层路由逻辑。' },
          { from: { type: 'providers' }, disallow: [{ to: { type: ['admin', 'api', 'app', 'router', 'users', 'middleware'] } }], message: 'Providers 聚焦外部模型对接，无权感知和依赖上层网络路由 (API) 和主应用 (App)。' },
          { from: { type: 'middleware' }, disallow: [{ to: { type: ['admin', 'api', 'app', 'router', 'providers', 'users'] } }], message: 'Middleware 中间件仅用于请求拦截，不应跨越边界调用具体路由控制层或外部供应商。' },
          { from: { type: 'api' }, disallow: [{ to: { type: ['admin', 'app', 'router'] } }], message: 'API 层用于处理具体路由逻辑，禁止直接引用 App 顶层容器或 Router 转发层。' },
          { from: { type: 'admin' }, disallow: [{ to: { type: ['api', 'app', 'router', 'providers', 'users'] } }], message: 'Admin 层是独立的控制台路由，无需关心网关API等逻辑。' },
          { from: { type: 'router' }, disallow: [{ to: { type: ['app'] } }], message: 'Router 层负责分发请求，不应依赖 App 顶层启动容器。' }
        ]
      }],

      // ===== Unicorn 定制 =====
      'unicorn/prevent-abbreviations': 'off', // 缩写过于严格，影响已有约定
      'unicorn/filename-case': 'off', // 不干预文件名规范，以免大范围报错
      'unicorn/no-null': 'off', // 在构建底层网关时，null 往往有明确语义
      'unicorn/prefer-module': 'off', // 项目中仍然可能混用 commonjs 或者由 typescript 自己管理 module
    },
  },

  {
    ignores: ['dist/', 'node_modules/', 'coverage/', 'ui/', 'shadcn-admin/', 'ui-compat/', 'copilot-api/'],
  },
  {
    files: ['src/**/*.test.ts'],
    rules: {
      // jest spy 的 .mockReturnValue() 等方法会触发 unbound-method，属框架固有限制，保留豁免
      '@typescript-eslint/unbound-method': 'off',
    }
  },
  biome
]);
