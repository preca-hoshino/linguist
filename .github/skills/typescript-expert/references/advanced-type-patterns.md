# Type System — Advanced Patterns

## Branded Types for Domain Modeling

```typescript
type Brand<K, T> = K & { __brand: T };
type UserId = Brand<string, 'UserId'>;
type OrderId = Brand<string, 'OrderId'>;

function processOrder(orderId: OrderId, userId: UserId) { }
```

- Use for: Critical domain primitives, API boundaries, currency/units
- See also: `utility-types.ts` for ready-to-copy implementations
- Resource: https://egghead.io/blog/using-branded-types-in-typescript

## Advanced Conditional Types

```typescript
// Recursive type manipulation
type DeepReadonly<T> = T extends (...args: any[]) => any
  ? T
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

// Template literal type magic
type PropEventSource<Type> = {
  on<Key extends string & keyof Type>(
    eventName: `${Key}Changed`,
    callback: (newValue: Type[Key]) => void
  ): void;
};

// Distributive vs non-distributive
type ToArray<T> = T extends any ? T[] : never           // distributive
type ToArrayND<T> = [T] extends [any] ? T[] : never     // non-distributive
```

Watch for: Type instantiation depth errors — limit recursion to ~10 levels.

## Type Inference Techniques

```typescript
// satisfies — constraint validation without widening (TS 5.0+)
const config = {
  api: "https://api.example.com",
  timeout: 5000
} satisfies Record<string, string | number>;

// const assertions — maximum literal inference
const routes = ['/home', '/about', '/contact'] as const;
type Route = typeof routes[number]; // '/home' | '/about' | '/contact'

// infer — extract inner types
type UnwrapPromise<T> = T extends Promise<infer U> ? U : T;
type Awaited2<T> = T extends Promise<infer U> ? Awaited2<U> : T;
```

## Mapped Types

```typescript
// Key remapping
type Getters<T> = {
  [K in keyof T as `get${Capitalize<string & K>}`]: () => T[K]
};

// Filtering keys
type OnlyStrings<T> = {
  [K in keyof T as T[K] extends string ? K : never]: T[K]
};
```

## Type Performance

```bash
# Diagnose slow type checking
npx tsc --extendedDiagnostics --incremental false | grep -E "Check time|Files:|Lines:|Nodes:"

# Trace analysis
npx tsc --generateTrace trace --incremental false
npx @typescript/analyze-trace trace
```

Common fixes for "Type instantiation is excessively deep":
1. Replace type intersections with `interface` extends
2. Split large union types (>100 members)
3. Avoid circular generic constraints
4. Use type aliases to break recursion

```typescript
// ❌ Infinite recursion
type InfiniteArray<T> = T | InfiniteArray<T>[];

// ✅ Limited recursion
type NestedArray<T, D extends number = 5> =
  D extends 0 ? T : T | NestedArray<T, [-1, 0, 1, 2, 3, 4][D]>[];
```

Build performance:
- `skipLibCheck: true` — skip library `.d.ts` checking
- `incremental: true` with `.tsbuildinfo` cache
- Precise `include`/`exclude` in tsconfig
- Monorepos: project references with `composite: true`
