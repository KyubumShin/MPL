---
description: Anti-pattern enumeration consumed by phase-runner self-check + mpl-fallback-grep hook (F2 / F3)
---

# Anti-Pattern Enumeration (F2 ground-truth registry)

**Loaded by**: `agents/mpl-phase-runner.md` `<Anti_Patterns_Prohibited>` (human-readable summary) and
`hooks/mpl-fallback-grep.mjs` (#105 F3, machine consumer).
**Source of truth**: yggdrasil-exp15 §11 retrofit audit (8/8 ground-truth catches at Tier 4, 7/8 at Tier 1+2+3).
**Issue**: #104 (F2). Companion: #105 (F3 grep hook), #106 (F4 doctor meta-self), #112 (F5 property check).

This file is the **single source-of-truth** for anti-pattern detection. Do not duplicate the patterns in code —
import from here.

## Schema (machine consumers)

Each pattern in `## Patterns` below contains a fenced `regex` block. Consumers read the regex blocks plus the
adjacent `permitted-when` block (if any). Encoding rules:

- `regex` block contains one ECMAScript-flavored regex per line. Newlines separate alternatives.
- `permitted-when` block contains plain prose conditions. Match counts as a violation **only if** none of these
  conditions hold. Hooks that cannot evaluate semantic exceptions surface the match as `warn` rather than `block`.
- `category` is one of `test-fake | gate-fake | type-safety | fallback-poison`.
- `severity` is one of `block | warn`. Hooks running in `enforcement.strict === true` mode (#110) elevate `warn` to
  `block`.

## Tier coverage (v3.10 §3)

| Tier | Mechanism | Catch rate (8 ground truths) | Cumulative cost |
|------|-----------|------------------------------|-----------------|
| 1 | Plain grep (this registry) | 5/8 | 1.5d |
| 2 | grep + proximity (file context) | 6/8 | +0.5d |
| 3 | property check (semantic) | 7/8 | +1.5d (#112) |
| 4 | agent audit (codex) | 8/8 | +2d (#117) |

Tier 1+2 are implemented in `mpl-fallback-grep.mjs` (#105). Tier 3 is `mpl-property-check.mjs` (#112). Tier 4 is the
codex auditor agent (#117).

---

## Patterns

### TC1 · Tautological assertion

- **id**: `TC1`
- **category**: `test-fake`
- **severity**: `block`
- **rationale**: The assertion holds regardless of the System Under Test. Test passes whether SUT is correct or not.
- **ground-truth count**: 5 (exp15)

```regex
expect\s*\(\s*true\s*\)\s*\.\s*toBe\s*\(\s*true\s*\)
expect\s*\(\s*1\s*\)\s*\.\s*toBe\s*\(\s*1\s*\)
assert(?:Equals?)?\s*\(\s*true\s*(?:,\s*true\s*)?\)
assert(?:Equals?)?\s*\(\s*1\s*,\s*1\s*\)
```

```permitted-when
- inside a test that explicitly verifies an environment precondition (e.g. "node version sane") and the comment
  on the same or previous line documents this intent
- inside a sanity smoke test labeled as such with `it.skip` or equivalent and a TODO comment
```

### TC2 · Conditional assertion

- **id**: `TC2`
- **category**: `test-fake`
- **severity**: `block`
- **rationale**: Assertion is silently skipped when condition is falsy; the test reports "no assertion" rather than
  failure. Real failures hide.
- **ground-truth count**: 9 (exp15; §11 originally found 1, retrofit surfaced 8 more)

```regex
if\s*\([^)]*\)\s*\{\s*expect\s*\(
if\s*\([^)]*\)\s*expect\s*\(
\?\s*expect\s*\([^)]*\)\s*:\s*(?:undefined|null|void\s*0)
```

```permitted-when
- the conditional is a type narrowing guard whose else-branch contains a separate `expect(...).toThrow(...)` or
  equivalent failing-path assertion (assertion exists in both branches)
- inside a parameterized test where the `it.each(...)` row carries an explicit `should-skip` flag and the test
  early-returns with `ctx.skip()`
```

### TC3 · Logged-but-not-asserted error path

- **id**: `TC3`
- **category**: `test-fake`
- **severity**: `block`
- **rationale**: Error is logged via console but no assertion fires. Failures appear as warnings in test output.

```regex
console\.(?:warn|error)\s*\([^)]*\)[\s;]*expect\s*\(\s*true\s*\)\s*\.\s*toBe\s*\(\s*true\s*\)
console\.(?:warn|error)\s*\([^)]*\)[\s;]*assert\s*\(\s*true\s*\)
```

```permitted-when
- (none — TC3 is always a violation)
```

### C2 · Config-as-decoration

- **id**: `C2`
- **category**: `gate-fake`
- **severity**: `warn` (Tier 3 / property check escalates to `block`)
- **rationale**: Config object is declared but no branch reads it. Looks configurable; behaves as a comment.
- **ground-truth source**: `release-gate.mjs:56`

```regex
^(?:export\s+)?const\s+([A-Z][A-Z0-9_]*_CONFIG|[A-Z][A-Z0-9_]*_THRESHOLDS?)\s*=\s*\{
```

```permitted-when
- a property-check pass (Tier 3) confirms the identifier is read elsewhere in the same module or in a sibling
  module within the phase scope
- the config is exported and consumed in a different module declared in the phase's `impact_scope`
```

### C3 · Silent INV PASS

- **id**: `C3`
- **category**: `gate-fake`
- **severity**: `block`
- **rationale**: Invariant logs "PASS" without an assertion / without setting a non-zero exit / without recording
  `evidence`. Always passes regardless of input.
- **ground-truth source**: `release-gate.mjs:295`

```regex
INV[- ][0-9]+[^\n]*PASS(?![^\n]*(?:exit_code|throw|process\.exit|assertion))
console\.log\s*\([^)]*INV[- ][0-9]+[^)]*\)(?![\s\S]{0,200}(?:throw|process\.exit|assert|expect\s*\())
```

```permitted-when
- the same logical block writes a structured `evidence` entry (file or `state.gate_results.*`) AND emits a non-zero
  exit code on the failing path
```

### M1 · Double-cast escape hatch

- **id**: `M1`
- **category**: `type-safety`
- **severity**: `warn` (test fixtures); `block` (production code)
- **rationale**: `as unknown as X` defeats the type checker by laundering one type into another with no runtime
  check.
- **ground-truth count**: 9 (exp15)

```regex
\bas\s+unknown\s+as\s+[A-Za-z_][A-Za-z0-9_]*
\bas\s+any\s+as\s+[A-Za-z_][A-Za-z0-9_]*
```

```permitted-when
- the line is inside a `*.test.{ts,tsx}` or `*.spec.{ts,tsx}` file AND the immediately preceding line is a comment
  naming the property under test (e.g. `// fixture: property under test is X`)
- the cast is annotated with `// eslint-disable-next-line @typescript-eslint/no-explicit-any` AND a justification
  comment on the same line
```

### CSP · Missing Content-Security-Policy

- **id**: `CSP`
- **category**: `type-safety`
- **severity**: `warn`
- **rationale**: Renderer HTML handling external content without CSP allows script injection.

```regex
<html(?:\s[^>]*)?>(?:(?!Content-Security-Policy)[\s\S])*?<body
```

```permitted-when
- CSP is enforced via response header (`Content-Security-Policy: ...`) confirmed in the same phase's `impact_scope`
- the file is a test fixture or a static demo with no external content
```

### D1 · Unconditional default-coalesce

- **id**: `D1`
- **category**: `fallback-poison`
- **severity**: `warn` (Tier 1) / `block` (Tier 3 with property-check confirming verification result LHS)
- **rationale**: `?? ''` / `?? []` / `?? null` on a verification result, exit code, or external response silently
  turns failure into a non-failure neutral value.
- **ground-truth source**: `release-gate.mjs:152` synthetic ID `\`no-git-${ISO}\``

```regex
\?\?\s*['"]\s*['"]
\?\?\s*\[\s*\]
\?\?\s*null\b
\bno-git-\$\{
\bunknown-\$\{
```

```permitted-when
- the LHS is a UI input value AND the default is the documented neutral form (e.g. empty string for an unset name
  field)
- the LHS is a typed union where `undefined` represents an explicit "absent" semantic and the default is exhaustively
  documented in an adjacent comment
```

### D2 · Swallowed promise rejection

- **id**: `D2`
- **category**: `fallback-poison`
- **severity**: `block`
- **rationale**: `.catch(() => false)` / `.catch(() => null)` turns a real promise rejection into a silent
  boolean/null. The caller cannot distinguish failure from valid `false`/`null`.
- **ground-truth count**: 11 (exp15)

```regex
\.\s*catch\s*\(\s*\(\s*\)\s*=>\s*false\b
\.\s*catch\s*\(\s*\(\s*\)\s*=>\s*null\b
\.\s*catch\s*\(\s*\(\s*\)\s*=>\s*undefined\b
\.\s*catch\s*\(\s*\(\s*\)\s*=>\s*void\s+0
```

```permitted-when
- the catch handler explicitly logs the structured error AND records it to `.mpl/signals/*` or equivalent persistent
  evidence: `\.catch\(\s*\(\s*err\b[\s\S]+?\)\s*=>\s*\{[^}]*(?:logger|writeFileSync|appendFileSync)`
```

---

## Self-application

These patterns apply to the MPL plugin's own source as well (R-DOCTOR-SELF-FALLBACK, v3.10 §3.1 #6/#7). Doctor's
`meta-self-fallback` sub-check (#106) runs this registry against `agents/`, `hooks/`, `commands/`, `skills/`,
`mcp-server/src/`. Self-exemption regexes are themselves a violation pattern surfaced by F4.

## How to add a new pattern

1. Add a `### IDx · Title` heading + `regex` + `permitted-when` blocks following the schema above.
2. Bump the `ground-truth count` if measured; otherwise mark `(unmeasured)`.
3. Update `agents/mpl-phase-runner.md` `<Anti_Patterns_Prohibited>` summary table.
4. Add a fixture-based unit test in `hooks/__tests__/mpl-fallback-grep.test.mjs` (#105).
5. Run the registry against the current MPL source (`hooks/`, `agents/`) to confirm zero new false positives or
   surface them with `permitted-when` clauses.
