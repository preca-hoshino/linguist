# Google TypeScript 风格指南 — 语言特性（第4章）

---

## 4.1 可见性

- 应当**尽可能限制**符号的可见性
- TypeScript 默认可见性为 `public`，除非在构造函数中声明公开且非只读的参数属性，否则**不要使用 `public` 修饰符**

```typescript
// ❌ 不要
class Foo {
    public bar = new Bar();
    constructor(public readonly baz: Baz) {}
}

// ✅ 应当
class Foo {
    bar = new Bar();
    constructor(public baz: Baz) {}  // 公开且非只读的参数属性可以用 public
}
```

---

## 4.2 构造函数

- 调用构造函数时**必须使用括号**，即使不传参数
- **不要**提供空的或仅调用父类构造函数的构造函数

```typescript
// ❌ 不要
const x = new Foo;
class UnnecessaryConstructor { constructor() {} }
class UnnecessaryConstructorOverride extends Base {
    constructor(value: number) { super(value); }
}

// ✅ 应当
const x = new Foo();
class DefaultConstructor {}
class ParameterProperties { constructor(private myService) {} }
class ParameterDecorators { constructor(@SideEffectDecorator myService) {} }
class NoInstantiation { private constructor() {} }
```

---

## 4.3 类成员

### `#private` 语法

**不要**使用 `#private` 私有字段语法，应使用 TypeScript 的 `private` 访问修饰符。

原因：私有字段语法编译后有体积和性能问题，且限制 TypeScript 最低只能编译至 ES2015。

```typescript
// ❌ 不要
class Clazz { #ident = 1; }

// ✅ 应当
class Clazz { private ident = 1; }
```

### `readonly`

不会在构造函数以外赋值的属性，应使用 `readonly`（不要求深层不可变）。

### 参数属性

**不要**在构造函数中显式初始化类成员，应使用参数属性语法：

```typescript
// ❌ 不要
class Foo {
    private readonly barService: BarService;
    constructor(barService: BarService) { this.barService = barService; }
}

// ✅ 应当
class Foo { constructor(private readonly barService: BarService) {} }
```

### 字段初始化

非参数属性应在声明时初始化：

```typescript
// ❌ 不要
class Foo {
    private readonly userList: string[];
    constructor() { this.userList = []; }
}

// ✅ 应当
class Foo { private readonly userList: string[] = []; }
```

### 用于类词法范围之外的属性

- 用于外部（如模板）的属性**禁止设为 `private`**
- Angular/Polymer 模板属性用 `public`，AngularJS 用 `protected`
- **禁止**使用 `obj['foo']` 语法绕过可见性限制

### 存取器（取值器与设值器）

- 取值器方法必须是**纯函数**（结果一致、无副作用）
- 若存取器仅传递属性值，不做任何逻辑，应直接将属性设为 `public`
- 只有取值器没有设值器，考虑设为 `readonly`
- 被隐藏的属性应以 `internal` 或 `wrapped` 作前缀/后缀

```typescript
// ✅ 应当
class Foo {
    private wrappedBar = '';
    get bar() { return this.wrappedBar || 'bar'; }
    set bar(wrapped: string) { this.wrappedBar = wrapped.trim(); }
}

// ❌ 不要：无逻辑的存取器
class Bar {
    private barInternal = '';
    get bar() { return this.barInternal; }
    set bar(value: string) { this.barInternal = value; }
}
```

---

## 4.4 原始类型与封装类

**不要**实例化原始类型的封装类（`String`、`Boolean`、`Number`）：

```typescript
// ❌ 不要
const s = new String('hello');
const b = new Boolean(false);
const n = new Number(5);

// ✅ 应当
const s = 'hello';
const b = false;
const n = 5;
```

---

## 4.5 数组构造函数

**禁止**使用 `Array()` 构造函数（有不一致的行为）：

```typescript
// ❌ 不要
const a = new Array(2);    // [undefined, undefined]
const b = new Array(2, 3); // [2, 3]

// ✅ 应当
const a = [2];
const b = [2, 3];
const c = [];
c.length = 2;
Array.from<number>({length: 5}).fill(0); // [0, 0, 0, 0, 0]
```

---

## 4.6 强制类型转换

```typescript
// ✅ 允许
const bool = Boolean(false);
const str = String(aNumber);
const bool2 = !!str;
const str2 = `result: ${bool2}`;

// 转数字：必须使用 Number()，并检查 NaN
const aNumber = Number('123');
if (isNaN(aNumber)) throw new Error(...);

// 整数转换
let f = Number(someString);
if (isNaN(f)) handleError();
f = Math.floor(f);
```

```typescript
// ❌ 禁止
const x = +y;                  // 一元加法转字符串为数字
const n = parseInt(someString, 10);  // 普通十进制禁止用（非十进制允许）
const f = parseFloat(someString);

// 条件语句不需要显式转 boolean
// ❌ 不要
if (!!foo) {...}

// ✅ 应当
if (foo) {...}
```

---

## 4.7 变量

- **必须**使用 `const` 或 `let` 声明变量，**禁止**使用 `var`
- 尽可能使用 `const`，仅在需要重新赋值时用 `let`
- 变量必须在使用前声明

---

## 4.8 异常

实例化异常时**必须使用 `new Error()`**，不要调用 `Error()` 函数：

```typescript
// ✅ 应当
throw new Error('Foo is not a valid bar.');

// ❌ 不要
throw Error('Foo is not a valid bar.');
```

---

## 4.9 对象迭代

**禁止**使用裸的 `for (...in...)` 语句（会包含原型链属性）：

```typescript
// ❌ 不要
for (const x in someObj) { ... }

// ✅ 应当（任选一种）
for (const x in someObj) {
    if (!someObj.hasOwnProperty(x)) continue;
    // ...
}

for (const x of Object.keys(someObj)) { ... }

for (const [key, value] of Object.entries(someObj)) { ... }
```

---

## 4.10 容器迭代

**不要**在数组上使用 `for (...in...)`（迭代的是下标而非元素，且被转为 `string`）：

```typescript
// ❌ 不要
for (const x in someArray) { ... }

// ✅ 应当
for (const x of someArr) { ... }
for (let i = 0; i < someArr.length; i++) { ... }
for (const [i, x] of someArr.entries()) { ... }
```

**不要**使用 `Array.prototype.forEach`、`Set.prototype.forEach`、`Map.prototype.forEach`（会让编译器的控制流分析失效，如 `null` 检查）：

```typescript
// ❌ 不要
someArr.forEach((item, index) => { someFn(item, index); });

// ✅ 应当
for (const item of someArr) { someFn(item); }
```

---

## 4.11 展开运算符

- 在创建对象时只能展开**对象**，在创建数组时只能展开**可迭代类型**
- **禁止**展开原始类型、`null` 和 `undefined`

```typescript
// ❌ 不要
const bar = {num: 5, ...(shouldUseFoo && foo)};  // 可能展开 undefined
const ids = {...fooStrings};  // 将数组展开到对象

// ✅ 应当
const foo = shouldUseFoo ? {num: 7} : {};
const bar = {num: 5, ...foo};
const ids = [...fooStrings, 'd', 'e'];
```

后出现的值会覆盖先出现的值。

---

## 4.12 控制流语句 / 语句块

多行控制流语句**必须使用大括号**。例外：能写在同一行的 `if` 可省略。

```typescript
// ✅ 应当
for (let i = 0; i < x; i++) {
    doSomethingWith(i);
    andSomeMore();
}

// ✅ 可以（同一行）
if (x) x.doFoo();

// ❌ 不要
if (x)
    x.doFoo();
```

---

## 4.13 `switch` 语句

- 所有 `switch` **必须包含 `default` 分支**（即使为空）
- 非空语句组**不允许越过分支向下执行**（fallthrough）
- 空语句组可以 fallthrough

```typescript
// ✅ 应当
switch (x) {
    case Y:
        doSomethingElse();
        break;
    default:
        // 什么也不做
}

// ✅ 空语句组 fallthrough 可以
switch (x) {
    case X:
    case Y:
        doSomething();
        break;
    default:
}
```

---

## 4.14 相等性判断

**必须**使用 `===` 和 `!==`，**不要**使用 `==` 和 `!=`。

**例外**：与 `null` 字面量比较可用 `==`（同时覆盖 `null` 和 `undefined`）：

```typescript
// ✅ 可以
if (foo == null) { ... }  // null 和 undefined 都会进入
```

---

## 4.15 函数声明

使用 `function foo() {...}` 声明具名函数，**不要**将函数表达式赋值给局部变量：

```typescript
// ✅ 应当
function foo() { ... }

// ❌ 不要
const foo = function() { ... }
```

**例外**：若函数需要访问外层 `this`，使用箭头函数赋值形式。

顶层箭头函数可显式声明实现了某个接口：
```typescript
interface SearchFunction { (source: string, subString: string): boolean; }
const fooSearch: SearchFunction = (source, subString) => { ... };
```

---

## 4.16 函数表达式

### 在表达式中使用箭头函数

**不要**使用 ES6 之前的 `function` 关键字定义函数表达式，应使用箭头函数：

```typescript
// ✅ 应当
bar(() => { this.doSomething(); })

// ❌ 不要
bar(function() { ... })
```

### 表达式函数体 vs 代码块函数体

只有在确实需要返回值时才使用表达式函数体：

```typescript
// ❌ 不要（不需要返回值却用了表达式函数体）
myPromise.then(v => console.log(v));

// ✅ 应当
myPromise.then(v => { console.log(v); });

// ✅ 即使需要返回值，为了可读性也可用代码块
const transformed = [1, 2, 3].map(v => {
    const intermediate = someComplicatedExpr(v);
    return worthWrapping(intermediate);
});
```

### 重新绑定 `this`

**不要**在函数表达式中使用 `this`，除非明确用于重新绑定：

```typescript
// ❌ 不要
document.body.onclick = clickHandler;  // this 隐式绑定到 document.body

// ✅ 应当
document.body.onclick = () => { document.body.textContent = 'hello'; };
const setTextFn = (e: HTMLElement) => { e.textContent = 'hello'; };
document.body.onclick = setTextFn.bind(null, document.body);
```

### 使用箭头函数作为属性

**通常**类不应将属性初始化为箭头函数。在调用实例方法时，必须用箭头函数形式：

```typescript
// ❌ 不要（this 在回调中丢失）
class DelayHandler {
    constructor() { setTimeout(this.patienceTracker, 5000); }
    private patienceTracker() { this.waitedPatiently = true; }
}

// ✅ 应当（显式处理 this）
class DelayHandler {
    constructor() { setTimeout(() => { this.patienceTracker(); }, 5000); }
    private patienceTracker() { this.waitedPatiently = true; }
}
```

**特例**：绑定到模板时，箭头函数属性是有用的（如事件句柄中的稳定引用）。

### 事件句柄

- 不需要卸载时：可用匿名箭头函数
- 需要卸载时：应用箭头函数属性（提供稳定引用，自动绑定 `this`）
- **不要**在注册事件时用 `bind`（会创建无法卸载的临时引用）

```typescript
// ✅ 应当
class Component {
    onAttached() {
        this.addEventListener('click', () => { this.listener(); });
        window.addEventListener('onbeforeunload', this.listener);
    }
    onDetached() {
        window.removeEventListener('onbeforeunload', this.listener);
    }
    private listener = () => { confirm('Do you want to exit the page?'); }
}

// ❌ 不要
window.addEventListener('onbeforeunload', this.listener.bind(this));
```

---

## 4.17 自动分号插入（ASI）

**不要**依赖 ASI，**必须**显式使用分号结束每个语句。

---

## 4.18 `@ts-ignore`

**不要**使用 `@ts-ignore`。应直接解决编译器报告的问题，而非绕过它。

---

## 4.19 类型断言与非空断言

类型断言（`x as T`）和非空断言（`y!`）是**不安全的**，仅在有明显理由时使用，并**应当**添加注释说明原因。

**优先**使用运行时检查代替断言：

```typescript
// ❌ 不要（随意使用）
(x as Foo).foo();
y!.bar();

// ✅ 应当
if (x instanceof Foo) { x.foo(); }
if (y) { y.bar(); }

// ✅ 可以（有明确原因时）
// x 是 Foo 类型，因为……
(x as Foo).foo();
```

### 类型断言语法

**必须**使用 `as` 语法，**不要**用尖括号语法：

```typescript
// ❌ 不要
const x = (<Foo>z).length;

// ✅ 应当
const x = (z as Foo).length;
```

### 类型断言与对象字面量

使用类型标记（`:Foo`）而非类型断言（`as Foo`）标明对象字面量的类型，有助于发现接口修改导致的 Bug：

```typescript
// ❌ 不要（字段改名后不会报错）
const foo = { bar: 123, bam: 'abc' } as Foo;

// ✅ 应当
const foo: Foo = { bar: 123, baz: 'abc' };
```

---

## 4.20 成员属性声明

接口和类的成员声明**必须使用 `;` 分隔**：

```typescript
// ✅ 接口
interface Foo {
    memberA: string;
    memberB: number;
}

// ❌ 不要用逗号
interface Foo {
    memberA: string,
    memberB: number,
}

// ✅ 内联对象类型使用逗号
type SomeTypeAlias = { memberA: string, memberB: number };
```

### 优化属性访问的兼容性

- **不要**混用方括号属性访问 `obj['foo']` 和句点 `obj.foo`
- 对程序外部对象属性声明对应接口：

```typescript
declare interface ServerInfoJson {
    appVersion: string;
    user: UserJson;
}
const data = JSON.parse(serverResponse) as ServerInfoJson;
console.log(data.appVersion);  // 类型安全！
```

### 优化模块对象导入的兼容性

导入模块时直接访问属性，不传递模块对象本身：

```typescript
// ✅ 应当
import {method1, method2} from 'utils';

// ❌ 不要
import * as utils from 'utils';
class A { readonly utils = utils; }
```

---

## 4.21 枚举

**必须**使用 `enum` 关键字，**不要**使用 `const enum`（`const enum` 会让枚举对 JavaScript 程序员透明，是独立的语言特性）。

---

## 4.22 `debugger` 语句

**不允许**在生产环境代码中添加 `debugger` 语句。

---

## 4.23 装饰器

- **不要**定义新的装饰器，只使用框架已定义的装饰器（如 Angular 的 `@Component`）
- 装饰器必须**紧接**被装饰的符号，中间不允许有空行

```typescript
/** JSDoc 注释应当位于装饰器之前 */
@Component({...})
class MyComp {
    @Input() myField: string;

    @Input()
    myOtherField: string;
}
```
