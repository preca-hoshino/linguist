# Problem Solving — Errors, Migration & Monorepo

## Common Error Patterns

### "The inferred type of X cannot be named"

Cause: Missing type export or circular dependency.

Fix priority:
1. Export the required type explicitly
2. Use `ReturnType<typeof function>` helper
3. Break circular dependencies with type-only imports (`import type`)

Resource: https://github.com/microsoft/TypeScript/issues/47663

---

### Missing type declarations

```typescript
// types/ambient.d.ts
declare module 'some-untyped-package' {
  const value: unknown;
  export default value;
  export = value; // if CJS interop is needed
}

// Augment existing module
declare module 'express' {
  interface Request {
    user?: { id: string }
  }
}
```

Reference: [Declaration Files Guide](https://www.typescriptlang.org/docs/handbook/declaration-files/introduction.html)

---

### "Excessive stack depth comparing types"

Cause: Circular or deeply recursive types.

Fix priority:
1. Limit recursion depth with conditional types (see `type-system.md`)
2. Use `interface` extends instead of type intersection
3. Simplify generic constraints

---

### Module Resolution Mysteries

"Cannot find module" despite file existing:
1. Check `moduleResolution` matches your bundler (`bundler` for Vite/esbuild, `node16`/`nodenext` for Node)
2. Verify `baseUrl` and `paths` alignment
3. Monorepos: Ensure workspace protocol (`workspace:*`)
4. Clear cache: `rm -rf node_modules/.cache .tsbuildinfo`

**Path Mapping at Runtime**: TypeScript paths are compile-time only.
- ts-node: `ts-node -r tsconfig-paths/register`
- Node ESM: use loader alternatives or avoid TS paths at runtime
- Production: pre-compile with resolved paths

## JavaScript → TypeScript Migration

```bash
# Step 1: Enable allowJs + checkJs in existing tsconfig.json
# (merge, do not create a new file)
# "allowJs": true, "checkJs": true

# Step 2: Rename files gradually (.js → .ts)

# Step 3: Add types file by file

# Step 4: Enable strict mode features incrementally

# Automated helpers (if installed)
npx ts-migrate migrate . --sources 'src/**/*.js'
npx typesync   # install missing @types packages
```

**Tool Migration Decisions**

| From              | To              | When                             | Effort     |
| ----------------- | --------------- | -------------------------------- | ---------- |
| ESLint + Prettier | Biome           | Speed critical, fewer rules OK   | Low (1d)   |
| TSC for linting   | Type-check only | 100+ files, need faster feedback | Med (2-3d) |
| Lerna             | Nx/Turborepo    | Need caching, parallel builds    | High (1w)  |
| CJS               | ESM             | Node 18+, modern tooling         | High       |

## Monorepo Setup

**Nx vs Turborepo**:
- **Turborepo**: Simple structure, speed priority, <20 packages
- **Nx**: Complex deps, visualization needed, plugins required, >50 packages

```json
// Root tsconfig.json for project references
{
  "references": [
    { "path": "./packages/core" },
    { "path": "./packages/ui" },
    { "path": "./apps/web" }
  ],
  "compilerOptions": {
    "composite": true,
    "declaration": true,
    "declarationMap": true
  }
}
```
