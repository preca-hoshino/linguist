# Tooling — Biome vs ESLint, Debugging & Type Testing

## Biome vs ESLint

|                       | Biome        | ESLint + typescript-eslint |
| --------------------- | ------------ | -------------------------- |
| Speed                 | Very fast    | Slower                     |
| Rules                 | ~64 TS rules | 100+ TS rules              |
| Type-aware linting    | ❌            | ✅                          |
| Vue / Angular support | Limited      | Full                       |
| Custom rules          | ❌            | ✅                          |
| Format + Lint         | Single tool  | Needs Prettier             |

**Choose Biome when**: Speed is critical, TypeScript-first project, single tool preferred.  
**Choose ESLint when**: Type-aware linting needed, specific plugins required, Vue/Angular project, complex custom rules.

## Type Testing

**Vitest (recommended)**:
```typescript
// avatar.test-d.ts
import { expectTypeOf } from 'vitest'
import type { Avatar } from './avatar'

test('Avatar props are correctly typed', () => {
  expectTypeOf<Avatar>().toHaveProperty('size')
  expectTypeOf<Avatar['size']>().toEqualTypeOf<'sm' | 'md' | 'lg'>()
})
```

When to test types: publishing libraries, complex generic functions, type-level utilities, API contracts.

Resources:
- [Vitest Type Testing](https://vitest.dev/guide/testing-types)
- [tsd](https://github.com/tsdjs/tsd) — standalone type testing

## CLI Debugging

```bash
# Direct execution
npx tsx --inspect src/file.ts
npx ts-node --inspect-brk src/file.ts

# Trace module resolution
npx tsc --traceResolution > resolution.log 2>&1
grep "Module resolution" resolution.log

# Type checking performance trace
npx tsc --generateTrace trace --incremental false
npx @typescript/analyze-trace trace

# Memory
node --max-old-space-size=8192 node_modules/typescript/lib/tsc.js
```

## Custom Error Classes

```typescript
class DomainError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number
  ) {
    super(message);
    this.name = 'DomainError';
    Error.captureStackTrace(this, this.constructor);
  }
}
```
