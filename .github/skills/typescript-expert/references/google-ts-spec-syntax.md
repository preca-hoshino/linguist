# Google TypeScript 风格指南 — 语法规范（第3章）

---

## 3.1 标识符

### 命名规范总表

| 命名法                           | 适用场景                               |
| -------------------------------- | -------------------------------------- |
| `UpperCamelCase`（帕斯卡）       | 类、接口、类型、枚举、装饰器、类型参数 |
| `lowerCamelCase`（驼峰）         | 变量、参数、函数、方法、属性、模块别名 |
| `CONSTANT_CASE`（全大写+下划线） | 全局常量、枚举值                       |
| `#ident`（私有成员）             | **不允许使用**                         |

### 具体规则

**缩写**：视为一个词。用 `loadHttpUrl` 而非 `loadHTTPURL`（平台特例除外，如 `XMLHttpRequest`）。

**美元符号 `$`**：一般不用，除非与第三方框架（如 jQuery）保持一致。`Observable` 类型值可用 `$` 后缀区分（团队内部约定）。

**类型参数**：单大写字母（如 `T`）或帕斯卡命名法（如 `UpperCamelCase`）均可。

**测试用例**：可用 `_` 作分隔符，如 `testX_whenY_doesZ()`。

**`_` 前缀/后缀**：**禁止使用**。不能用 `_` 表示未使用参数，改用解构忽略：
```typescript
const [a, , b] = [1, 5, 10];  // a <- 1, b <- 10
```

**导入模块**：命名空间用 `lowerCamelCase`，文件名用 `snake_case`：
```typescript
import * as fooBar from './foo_bar';
```

**常量**：`CONSTANT_CASE` 表示不应被修改（含类中静态只读属性）：
```typescript
const UNIT_SUFFIXES = { 'milliseconds': 'ms', 'seconds': 's' };

class Foo {
    private static readonly MY_SPECIAL_NUMBER = 5;
}
```

**其他**：若值在生命周期内会多次实例化或被修改，必须用驼峰式命名。

### 别名

创建局部作用域别名时，命名方式与原标识符保持一致，声明使用 `const` 或 `readonly`：
```typescript
const { Foo } = SomeType;
const CAPACITY = 5;

class Teapot {
    readonly BrewStateEnum = BrewStateEnum;
    readonly CAPACITY = CAPACITY;
}
```

### 命名风格

- **不要**为私有属性/方法添加 `_` 前缀或后缀
- **不要**为可选参数添加 `opt_` 前缀
- **不要**显式标记接口类型（如 `IMyInterface`），除非项目已有此惯例
- 接口名应描述创建原因（如将 `TodoItem` 转 JSON 的接口命名为 `TodoItemStorage`）

### 描述性命名

- 命名应具有描述性，不使用含糊的缩写
- **例外**：不超过 10 行作用域内的变量，或内部 API 参数，可用 `i`、`j` 等短名

---

## 3.2 文件编码

使用 **UTF-8** 文件编码。

```typescript
// ✅ 应当：使用实际 Unicode 字符
const units = 'μs';

// ✅ 应当：对非输出字符转义并注释
const output = '\ufeff' + content;  // 字节顺序标记（BOM）

// ❌ 不要：即使加注释也不好读
const units = '\u03bcs'; // Greek letter mu, 's'

// ❌ 不要：省略注释
const output = '\ufeff' + content;
```

---

## 3.3 注释与文档

### 注释类型

- **文档注释**（用户应阅读）：使用 `/** JSDoc */`
- **实现说明**（仅与实现细节相关）：使用 `//` 或 `/* */`

JSDoc 可被工具（编辑器、文档生成器）识别；普通注释只供人阅读。

### JSDoc 规范

大部分遵循 JavaScript 风格指南中注释一节的规则。

### 哪些需要注释

**所有导出的顶层模块**必须使用 JSDoc 注释。若代码审核人认为某属性/方法的作用不能一目了然，也需要注释（无论是否导出或公开）。

### 省略多余注释

**不要**在 `@param` / `@return` 中声明类型；**不要**在已使用 `implements`、`enum`、`private` 等关键字处添加 `@implements`、`@enum`、`@private` 注释。

### 不使用 `@override`

`@override` 不被编译器视为强制约束，会导致注释与实现不一致，令人困惑。

### 注释必须言之有物

```typescript
// ❌ 不要：无有意义内容
/** @param fooBarService Foo 应用的 Bar 服务 */

// ✅ 应当：添加额外有用信息
/**
 * 发送 POST 请求，开始煮咖啡
 * @param amountLitres 煮咖啡的量，注意和煮锅的尺寸对应！
 */
brew(amountLitres: number, logger: Logger) { ... }
```

### 参数属性注释

通过构造函数参数创建的参数属性，使用 JSDoc 的 `@param` 注释，编辑器在调用构造函数和访问属性时均会显示描述：
```typescript
class ParamProps {
    /**
     * @param percolator 煮咖啡所用的咖啡壶
     * @param beans 煮咖啡所用的咖啡豆
     */
    constructor(
        private readonly percolator: Percolator,
        private readonly beans: CoffeeBean[]) {}
}
```

### 函数调用注释

```typescript
// 使用行内块注释
new Percolator().brew(/* amountLitres= */ 5);

// 或使用字面量对象命名参数
new Percolator().brew({amountLitres: 5});
```

### 将文档置于装饰器之前

```typescript
// ❌ 不要：JSDoc 夹在装饰器和类之间
@Component({ selector: 'foo', template: 'bar' })
/** 打印 "bar" 的组件。 */
export class FooComponent {}

// ✅ 应当：JSDoc 位于装饰器之前
/** 打印 "bar" 的组件。 */
@Component({ selector: 'foo', template: 'bar' })
export class FooComponent {}
```
