# Best Practices — Config, ESM, Code Review & Resources

## Strict tsconfig (see also `tsconfig-strict.json`)

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "noPropertyAccessFromIndexSignature": true
  }
}
```

## ESM-First

- `"type": "module"` in package.json
- Use `.mts` for TypeScript ESM files if needed
- `"moduleResolution": "bundler"` for modern tools (Vite, esbuild)
- CJS interop: `const pkg = await import('cjs-package')` (may need `.default`)

## Code Review Checklist

### Type Safety
- [ ] No implicit `any` — use `unknown` or proper types
- [ ] Strict null checks handled
- [ ] Type assertions (`as`) minimal and justified
- [ ] Generic constraints properly defined
- [ ] Discriminated unions for error handling
- [ ] Return types explicit on public APIs

### TypeScript Idioms
- [ ] `interface` over `type` for object shapes (better errors)
- [ ] `const` assertions for literal types
- [ ] Type guards and predicates used correctly
- [ ] No type gymnastics when a simpler solution exists
- [ ] Branded types for domain primitives

### Performance
- [ ] Type complexity doesn't slow compilation
- [ ] No excessive instantiation depth
- [ ] `skipLibCheck: true` in tsconfig
- [ ] Project references for monorepos

### Module System
- [ ] Consistent import/export patterns
- [ ] No circular dependencies
- [ ] Barrel exports not over-bundling
- [ ] ESM/CJS compatibility handled
- [ ] Dynamic imports used for code splitting

### Error Handling
- [ ] Result types or discriminated unions
- [ ] Custom error classes with proper inheritance
- [ ] Exhaustive `switch` with `never` fallthrough

### Organization
- [ ] Types co-located with implementation
- [ ] Shared types in dedicated modules
- [ ] No unnecessary global type augmentation
- [ ] `.d.ts` declaration files used appropriately

## Decision Trees

**Which tool?**
```
Type checking only?                   → tsc
Linting + speed critical?             → Biome
Linting + type-aware / comprehensive? → ESLint + typescript-eslint
Type testing?                         → Vitest expectTypeOf
Build tool, <10 packages?             → Turborepo
Build tool, ≥10+ packages?            → Nx
```

**Performance issue?**
```
Slow type checking?    → skipLibCheck, incremental, project references
Slow builds?           → Check bundler config, enable caching
Slow tests?            → Vitest with threads, skip type checking in tests
Slow language server?  → Exclude node_modules, limit tsconfig include
```

## Resources

- [TypeScript Performance Wiki](https://github.com/microsoft/TypeScript/wiki/Performance)
- [Type Challenges](https://github.com/type-challenges/type-challenges)
- [Type-Level TypeScript](https://type-level-typescript.com)
- [Biome](https://biomejs.dev)
- [TypeStat](https://github.com/JoshuaKGoldberg/TypeStat) — auto-fix TS types
- [ts-migrate](https://github.com/airbnb/ts-migrate) — JS→TS migration
