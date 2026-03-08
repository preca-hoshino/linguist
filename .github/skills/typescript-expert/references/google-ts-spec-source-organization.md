# Google TypeScript 风格指南 — 代码管理（第5章）

---

## 5.1 模块

### 导入路径

- **必须**使用路径导入（相对路径 `./foo` 或绝对路径 `root/path/to/file`）
- 引用同一项目文件时，使用相对路径 `./foo`，不用绝对路径 `path/to/foo`
- 尽可能**限制父层级数量**（避免 `../../../`）

```typescript
import {Symbol1} from 'google3/path/from/root';
import {Symbol2} from '../parent/file';
import {Symbol3} from './sibling';
```

### 用命名空间还是模块？

**不允许**使用命名空间，**必须**使用 ES6 模块。

```typescript
// ❌ 不要
namespace Rocket { function launch() { ... } }
/// <reference path="..."/>
import x = require('mydep');

// ✅ 应当：使用 ES6 import/export
import {foo} from 'bar';
```

> `module Foo {...}` 也是命名空间，不要使用。任何时候都应使用 ES6 导入语法。

---

## 5.2 导出

**必须**使用**具名导出**，**不要**使用默认导出：

```typescript
// ✅ 应当
export class Foo { ... }
export const SOME_CONSTANT = ...
export function someHelpfulFunction() { ... }

// ❌ 不要
export default class Foo { ... }
```

**原因**：默认导出不为符号提供标准名称，增加维护难度，允许任意命名导入从而降低可读性。

### 导出可见性

TypeScript 不支持限制导出符号的可见性，因此**不要导出**不用于模块以外的符号，**尽量减小**模块外部 API 的规模。

### 可变导出

**不允许**使用 `export let`（可变导出）：

```typescript
// ❌ 不要
export let foo = 3;

// ✅ 应当：提供显式取值器
let foo = 3;
export function getFoo() { return foo; }

// ✅ 条件导出应保证模块执行完后值是确定的
function pickApi() {
    if (useOtherApi()) return OtherApi;
    return RegularApi;
}
export const SomeApi = pickApi();
```

### 容器类

**不要**为命名空间创建含静态方法或属性的容器类，改用单独导出的常量和函数：

```typescript
// ❌ 不要
export class Container {
    static FOO = 1;
    static bar() { return 1; }
}

// ✅ 应当
export const FOO = 1;
export function bar() { return 1; }
```

---

## 5.3 导入

ES6 和 TypeScript 中有四种导入变体：

| 变体       | 语法                            | 使用场景                             |
| ---------- | ------------------------------- | ------------------------------------ |
| 模块导入   | `import * as foo from '...'`    | TypeScript 推荐方式                  |
| 解构导入   | `import {SomeThing} from '...'` | TypeScript 推荐方式                  |
| 默认导入   | `import SomeThing from '...'`   | 只用于外部代码的特殊需求             |
| 副作用导入 | `import '...'`                  | 只用于加载库的副作用（如自定义元素） |

```typescript
// ✅ 应当
import * as ng from '@angular/core';
import {Foo} from './foo';
import Button from 'Button';       // 仅在有需要时使用默认导入
import 'jasmine';                   // 副作用导入
import '@polymer/paper-button';
```

### 选择模块导入还是解构导入？

**模块导入**适合：导入多个符号时提供更好可读性，允许自动补全，减少命名冲突：

```typescript
// ✅ 应当：使用模块作为命名空间
import * as tableview from './tableview';
let item: tableview.Item = ...;
```

**解构导入**适合：常用符号，使用时代码更简洁：

```typescript
// ✅ 这样做更好（高频使用的少数符号）
import {describe, it, expect} from './testing';
describe('foo', () => {
    it('bar', () => { expect(...); });
});
```

### 重命名导入

以下情况可使用重命名导入（`import {SomeThing as SomeOtherThing}`）：

1. 避免与其他导入产生命名冲突
2. 被导入符号名称是自动生成的
3. 名称不够清晰，需重命名提高可读性（如将 RxJS 的 `from` 重命名为 `observableFrom`）

### `import type` 和 `export type`

**不要**使用 `import type ... from` 或 `export type ... from`：

```typescript
// ❌ 不要
import type {Foo} from './foo';
export type {Bar} from './bar';

// ✅ 应当
import {Foo} from './foo';
export {Bar} from './bar';
```

> **例外**：导出类型定义 `export type Foo = ...;` 是允许的。

原因：TypeScript 工具链会自动区分类型符号和值符号，无需手动区分，且 `import type` 并不提供任何保证（代码仍可通过其他途径导入同一依赖）。

---

## 5.4 根据特征组织代码

应当**根据特征**而非类型组织代码。

```
// ✅ 应当（按特征）
products/
checkout/
backend/

// ❌ 不要（按类型）
views/
models/
controllers/
```
