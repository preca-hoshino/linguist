# Google TypeScript 风格指南 — 类型系统（第6章）

---

## 6.1 类型推导

对所有类型的表达式（变量、字段、返回值等）都可以依赖 TypeScript 的类型推导。

当变量/参数被初始化为 `string`、`number`、`boolean`、`RegExp` 字面量或 `new` 表达式时，**应当省略**类型记号：

```typescript
// ❌ 不要（类型显然可推导）
const x: boolean = true;
const x: Set<string> = new Set();

// ✅ 应当
const x = true;
const x = new Set<string>();
```

对复杂表达式，类型记号有助于可读性，是否标注由代码审查员决定。

### 返回类型

作者可自由决定是否标明返回类型。显式标注的优点：
- 生成更精确文档
- 若返回类型改变，错误暴露更快

---

## 6.2 Null 还是 Undefined？

TypeScript 代码中可以使用 `undefined` 或 `null` 标记缺少的值，无通用规则。惯例：
- JavaScript API 多用 `undefined`（如 `Map.get`）
- DOM 和 Google API 多用 `null`（如 `Element.getAttribute`）

### 可空/未定义类型别名

**不允许**为包含 `|null` 或 `|undefined` 的联合类型创建类型别名：

```typescript
// ❌ 不要
type CoffeeResponse = Latte|Americano|undefined;
class CoffeeService { getLatte(): CoffeeResponse { ... } }

// ✅ 应当：在使用别名时才联合 undefined
type CoffeeResponse = Latte|Americano;
class CoffeeService { getLatte(): CoffeeResponse|undefined { ... } }

// ✅ 更好：使用断言处理可能的空值
class CoffeeService {
    getLatte(): CoffeeResponse {
        return assert(fetchResponse(), 'Coffee maker is broken');
    }
}
```

### 可选参数 还是 `undefined` 类型？

**应当**使用可选字段/参数而非联合 `|undefined` 类型：

```typescript
interface CoffeeOrder {
    sugarCubes: number;
    milk?: Whole|LowFat|HalfHalf;  // ✅ 可选字段
}

function pourCoffee(volume?: Milliliter) { ... }  // ✅ 可选参数
```

对于类，**尽可能**初始化每一个字段，避免可选字段：

```typescript
class MyClass { field = ''; }
```

---

## 6.3 结构类型 与 指名类型

TypeScript 使用**结构类型**（而非指名类型）。规范：
- 测试代码**以外**：**应当**使用接口而非类定义结构类型
- 测试代码中：创建 Mock 对象时不引入接口较为方便

在符号声明位置**显式包含其类型**，使类型检查更准确：

```typescript
// ✅ 应当
const foo: Foo = { a: 123, b: 'abc' }

// ❌ 不要（类型通过推导，若添加额外字段可能出错且错误提示在调用处）
const badFoo = { a: 123, b: 'abc' }
```

---

## 6.4 接口 还是 类型别名？

声明对象类型时，**应当使用接口**而非对象字面量类型别名：

```typescript
// ✅ 应当
interface User {
    firstName: string;
    lastName: string;
}

// ❌ 不要
type User = {
    firstName: string,
    lastName: string,
}
```

类型别名仍可用于基本类型、联合类型、元组等：

```typescript
type MyType = number|string;
type MyTuple = [string, number];
```

---

## 6.5 `Array<T>` 类型

- 简单类型（仅含字母、数字、`.`）：使用 `T[]` 语法糖
- 复杂类型：使用 `Array<T>`

```typescript
// ✅ 应当
const a: string[];
const b: readonly string[];
const c: ns.MyObj[];
const d: Array<string|number>;
const e: ReadonlyArray<string|number>;

// ❌ 不要
const f: Array<string>;            // 语法糖写法更短
const g: ReadonlyArray<string>;
const h: {n: number, s: string}[]; // 大括号和中括号让这行代码难以阅读
const i: (string|number)[];
```

---

## 6.6 索引类型 `{[key: string]: number}`

为键提供**有意义的标签名**：

```typescript
// ❌ 不要
const users: {[key: string]: number} = ...;

// ✅ 应当
const users: {[userName: string]: number} = ...;
```

**推荐**使用 ES6 的 `Map` 与 `Set` 类型代替对象关联数组（行为更明确，键支持非 `string` 类型）。

TypeScript 内建的 `Record<Keys, ValueType>` 可用于键为静态确定的场景（参见映射类型一节）。

---

## 6.7 映射类型与条件类型

`Record`、`Partial`、`Readonly`、`Pick` 等类型运算符很强大，但有以下缺点：
- 需要读者自行在头脑中对类型表达式求值，增加理解难度
- 求值模型随 TypeScript 版本变化，有维护风险
- 部分 IDE 工具（如"查找引用"）不能正确识别

**推荐规范**：
- 使用最简单的类型构造方式
- 一定程度的重复/冗余通常好过复杂类型表达式
- 映射类型和条件类型必须在符合上述理念的情况下使用

```typescript
// ❌ 不推荐（虽然可以）
type FoodPreferences = Pick<User, 'favoriteIcecream'|'favoriteChocolate'>;

// ✅ 更推荐（更易理解）
interface FoodPreferences {
    favoriteIcecream: string;
    favoriteChocolate: string;
}

// ✅ 更好：通过继承减少重复
interface FoodPreferences { ... }
interface User extends FoodPreferences { shoeSize: number; }
```

---

## 6.8 `any` 类型

`any` 是所有类型的超类又是子类，允许解引用任意属性，会掩盖严重错误。**尽可能不要**使用 `any`。

替代方案：

### 提供更具体的类型

```typescript
declare interface MyUserJson { name: string; email: string; }
type MyType = number|string;
function getTwoThings(): {something: number, other: string} { ... }
function nicestElement<T>(items: T[]): T { ... }  // 泛型代替 any
```

### 使用 `unknown` 而非 `any`

`unknown` 能表达相同语义，但在缩窄类型前不能解引用属性，更安全：

```typescript
// ✅ 应当
const val: unknown = value;
// 需要先类型检查才能使用

// ❌ 不要
const danger: any = value;
danger.whoops();  // 未经检查的访问！
```

### 关闭 Lint 工具对 `any` 的警告

若确实合理（如测试中构造 Mock），添加注释关闭警告并说明理由：

```typescript
// tslint:disable-next-line:no-any
const mockBookService = ({get() { return mockBook; }} as any) as BookService;
```

---

## 6.9 元组类型

**应当**使用元组类型代替 `Pair` 接口：

```typescript
// ❌ 不要
interface Pair { first: string; second: string; }

// ✅ 应当
function splitInHalf(input: string): [string, string] { return [x, y]; }
const [leftHalf, rightHalf] = splitInHalf('my string');
```

若属性需要有意义的名称，使用内联对象类型：

```typescript
function splitHostPort(address: string): {host: string, port: number} { ... }
const {host, port} = splitHostPort(userAddress);
```

---

## 6.10 包装类型

**不要**使用以下类型（它们是原始类型的包装类型，含义略有不同）：

| 禁止使用  | 应当使用         |
| --------- | ---------------- |
| `String`  | `string`         |
| `Boolean` | `boolean`        |
| `Number`  | `number`         |
| `Object`  | `{}` 或 `object` |

- `{}`：包括除 `null` 和 `undefined` 之外的所有类型
- `object`：所有基本类型以外的类型

**不要**将包装类型用作构造函数。

---

## 6.11 只有泛型的返回类型

**不要**创建返回类型只有泛型的 API。若使用现有此类 API，应**显式标明**泛型参数类型。
