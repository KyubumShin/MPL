# Language: TypeScript

## Core Principles
- Enforce `strict` mode, prohibit `any` (replace with `unknown` followed by narrowing)
- Leverage type narrowing: type guard functions, discriminated unions to narrow types
- Prefer `const assertion` (`as const`) or union types over `enum`
- Distinguish `null` from `undefined` and utilize optional chaining (`?.`) and nullish coalescing (`??`)
- Introduce generics only when genuinely reused (avoid over-abstraction)

## Cautions
- Type assertions (`as`) are only permitted when runtime safety is guaranteed
- `@ts-ignore` / `@ts-expect-error` require a reason comment
- Accessing `unknown` types without a runtime guard is prohibited
- Keep the usage criteria of interfaces vs. type aliases consistent within the project

## Verification Points
- Does `tsc --noEmit` pass without errors?
- Does ESLint (`@typescript-eslint`) pass?
- Are there no `any` usages or reckless type assertions?
- Are there no strict null check violations?
