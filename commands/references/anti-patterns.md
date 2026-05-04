---
description: Anti-pattern enumeration consumed by phase-runner self-check + mpl-fallback-grep hook (F2 / F3)
---

# Anti-Pattern Enumeration (F2 ground-truth registry)

**Loaded by**: `agents/mpl-phase-runner.md` `<Anti_Patterns_Prohibited>` (human-readable summary) and
`hooks/mpl-fallback-grep.mjs` (#105 F3, machine consumer).
**Source of truth**: yggdrasil-exp15 §11 retrofit audit (8 distinct ground-truth anti-patterns; expanded into 10 regex
IDs here for finer addressability). See §"Ground-truth → registry mapping" for the explicit 8 → 10 expansion.
**Issue**: #104 (F2). Companion: #105 (F3 grep hook), #106 (F4 doctor meta-self), #112 (F5 property check),
#117 (F6 codex auditor).

This file is the **single source-of-truth** for anti-pattern detection. Do not duplicate the patterns in code —
import from here.

## Scope (file extensions)

The registry applies to **source code only**. Allowed extensions:

```scope
.mjs .cjs .js .jsx .ts .tsx
.py .pyw
.rs .go .java .kt .scala
.c .cpp .cc .h .hpp
.rb .php .swift
.sh .bash .zsh
.sql
```

Excluded (treated as documentation, never matched against the registry):

```scope-excluded
.md .mdx .txt .rst .adoc
.json .yaml .yml .toml
*.test.{ts,tsx,js,jsx,mjs}    # tested via `tier_overrides.test_files`
```

The registry document itself (`commands/references/anti-patterns.md`) and `<Anti_Patterns_Prohibited>` blocks inside
agent prompts (`agents/*.md`) **MUST NOT be scanned by F3/F4** — those are documentation surfaces for the registry
itself and necessarily contain literal example occurrences. F3/F4 enforce path-extension filtering before regex
evaluation. (PR #120 self-application contract fix.)

## Schema (machine consumers)

Each pattern under `## Patterns` is a level-3 heading (`### IDx · Title`) followed by a YAML-like front matter then
two fenced blocks. Strict grammar:

```bnf
pattern        := heading frontmatter regex_block permitted_block
heading        := "### " ID " · " Title
frontmatter    := bullet_list of: id | category | severity | escalation? | rationale | ground_truth_count
regex_block    := "```regex" newline regex_lines "```"
permitted_block:= "```permitted-when" newline prose_lines "```"
regex_lines    := one ECMAScript regex per line; newlines separate OR-alternatives
```

Field semantics:

- **id**: short identifier (`TC1`, `D1.a`, etc.) used in F3/F4 logs and metric counts.
- **category**: enum `test-fake | gate-fake | type-safety | fallback-poison`.
- **severity**: enum `block | warn`. **Single value, no compound.** All escalation rules go in `escalation`.
- **escalation** (optional): structured prose describing when severity elevates. Common forms:
  - `tier_3_block_in: <selector>` — Tier 3 (#112) escalates to block when path/scope matches.
  - `strict_block` — `enforcement.strict` (#110) elevates to block. Default for `severity: warn` unless overridden.
  - `tier_3_only` — Tier 1 grep does not act; Tier 3 property-check is the authoritative consumer.
- **rationale**: 1-line semantic justification.
- **ground-truth count**: integer + source label, or `(unmeasured)`.

Hooks running below `enforcement.strict === true` (#110) elevate `severity: warn` patterns to `block`, **except**
when `escalation` explicitly overrides (e.g. `tier_3_only` keeps Tier 1 silent regardless of strict).

## Tier coverage (v3.10 §3)

| Tier | Mechanism | Catch rate (8 GT) | Cumulative cost |
|------|-----------|-------------------|-----------------|
| 1 | Plain grep (this registry) | 5/8 | 1.5d |
| 2 | grep + proximity (file context) | 6/8 | +0.5d |
| 3 | property check (semantic, file-scope-aware) | 7/8 | +1.5d (#112) |
| 4 | agent audit (codex) | 8/8 | +2d (#117) |

Tier 1+2 are implemented in `mpl-fallback-grep.mjs` (#105). Tier 3 is `mpl-property-check.mjs` (#112). Tier 4 is the
codex auditor agent (#117).

## Ground-truth → registry mapping

exp15 §11 reported 8 distinct anti-patterns. Some are split into multiple regex IDs in this registry for tighter
metric attribution and divergent permitted-when semantics:

| GT # | exp15 §11 finding | Registry IDs | Reason for split |
|------|-------------------|--------------|------------------|
| 1 | Tautological test assertion | `TC1` | 1:1 |
| 2 | Conditional assertion | `TC2` | 1:1 |
| 3 | Logged-but-not-asserted error path | `TC3` | 1:1 |
| 4 | Config-as-decoration (release-gate.mjs:56) | `C2` | 1:1 |
| 5 | Silent INV PASS (release-gate.mjs:295) | `C3` | 1:1 |
| 6 | Double-cast escape hatch | `M1` | 1:1 |
| 7 | Unconditional default-coalesce + synthetic-ID literal | `D1.a`, `D1.b` | exp15 conflated; this registry splits coalesce poisoning vs synthetic-id masking — different `permitted-when` semantics, different metric |
| 8 | Swallowed promise rejection | `D2` | 1:1 |
| add | Missing CSP meta tag (renderer hardening) | `CSP` | added beyond exp15 §11; not part of 8 GT — explicitly labeled `(unmeasured)` |

**Catch rate accounting**: "Tier 4 catch 8/8" refers to the **8 ground truths**, not the 10 registry IDs. CSP is
added as a defensive item (no exp15 measurement); D1.a + D1.b together count as catching GT #7. Future expansions
must update this table to keep the 8/8 vs 10-ID accounting transparent.

## F3 / F4 parsing contract

Machine consumers parse this file as follows:

1. **Path filter first**: only files matching `## Scope` extensions are subject to enforcement. Markdown / config /
   documentation files are skipped before any regex compiles. (Self-application safety.)
2. **Pattern discovery**: walk markdown headings starting with `### `; for each, the immediately following bullet
   list is the front matter and the next two fenced blocks are `regex` and `permitted-when`. Heading order in the
   file does not matter.
3. **Regex compilation**: parse each non-blank line of `regex` block as a separate ECMAScript regex. The compiled
   set is OR-joined (a file matches a pattern when any regex line matches).
4. **Severity decision**: read `severity` enum directly. Apply `escalation` rules in order:
   `tier_3_only` → Tier 1 silent; `tier_3_block_in: <selector>` → Tier 3 elevates per selector; `strict_block` (or
   absence with `severity: warn`) → strict mode elevates to block.
5. **Permitted-when handling**: Tier 1/2 (grep, proximity) cannot evaluate semantic exceptions; they emit `warn`
   even on otherwise-block patterns when the file is in a context the prose mentions (e.g. test fixtures), and
   defer authoritative decisioning to Tier 3 (property check) which has scope/path awareness.
6. **Match output**: `{ id, category, severity, file, line, snippet, permitted_when_applicable: bool }`. Logged to
   `.mpl/signals/anti-pattern-hits.jsonl`.

Reference fixture file (F3 PR #105 will ship): `hooks/__tests__/fixtures/anti-pattern-corpus/` — one `.fixture.{ts,
mjs,...}` per pattern with both positive and negative cases, asserted to produce expected match counts.

---

## Patterns

### TC1 · Tautological assertion

- **id**: `TC1`
- **category**: `test-fake`
- **severity**: `block`
- **escalation**: `tier_3_block_in: production` (test fixtures may opt in via `permitted-when`)
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
- **escalation**: `strict_block`
- **rationale**: Assertion is silently skipped when condition is falsy; the test reports "no assertion" rather than
  failure. Real failures hide.
- **ground-truth count**: 9 (exp15; §11 originally found 1, retrofit surfaced 8 more)

```regex
if\s*\([^)]*\)\s*\{\s*expect\s*\(
if\s*\([^)]*\)\s*expect\s*\(
\?\s*expect\s*\([^)]*\)\s*:\s*(?:undefined|null|void\s*0)
[^|&\n]&&\s*expect\s*\(
return\s+expect\s*\([^)]*\)\s*\.\s*toBe
```

```permitted-when
- the conditional is a type narrowing guard whose else-branch contains a separate `expect(...).toThrow(...)` or
  equivalent failing-path assertion (assertion exists in both branches)
- inside a parameterized test where the `it.each(...)` row carries an explicit `should-skip` flag and the test
  early-returns with `ctx.skip()`
- short-circuit `cond && expect(...)` inside an `it.each` row guarded by parameterized invariants — Tier 3
  property-check confirms the parameterized contract
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
- **severity**: `warn`
- **escalation**: `tier_3_block_in: production` (Tier 3 property-check confirms the const is unread; on confirmation
  in non-test path, escalates to block)
- **rationale**: Config object is declared but no branch reads it. Looks configurable; behaves as a comment.
- **ground-truth source**: `release-gate.mjs:56`

```regex
^(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*\{
^(?:export\s+)?const\s+([A-Za-z][A-Za-z0-9_]*(?:Config|Settings|Options|Rules|Params|Thresholds?))\s*=\s*\{
```

Tier 1 broad-net: any top-level uppercase const initialized as object literal, OR any const whose name ends with
`Config|Settings|Options|Rules|Params|Threshold(s)`. Tier 3 property-check confirms whether the identifier is read
elsewhere in the same module or an exported sibling within `phase.impact_scope`. The naming convention from earlier
versions (`*_CONFIG` / `*_THRESHOLDS?` only) was too narrow — now broadened per PR #120 review #4.

```permitted-when
- a property-check pass (Tier 3) confirms the identifier is read elsewhere in the same module or in a sibling
  module within the phase scope
- the config is exported and consumed in a different module declared in the phase's `impact_scope`
- the const is part of a public API surface re-exported from an `index.{ts,mjs}` barrel
```

### C3 · Silent INV PASS

- **id**: `C3`
- **category**: `gate-fake`
- **severity**: `block`
- **escalation**: `tier_3_only` (Tier 1 emits `warn` only; the 200-char window is approximate and Tier 3 block-scope
  analysis is authoritative — Tier 1 false-negatives in long functions are tolerated)
- **rationale**: Invariant logs "PASS" without an assertion / without setting a non-zero exit / without recording
  `evidence`. Always passes regardless of input.
- **ground-truth source**: `release-gate.mjs:295`

```regex
INV[- ][0-9]+[^\n]*PASS(?![^\n]*(?:exit_code|throw|process\.exit|assertion))
console\.log\s*\([^)]*INV[- ][0-9]+[^)]*\)(?![\s\S]{0,200}(?:throw|process\.exit|assert|expect\s*\())
```

The `{0,200}` lookahead window is an approximate function-body width; chosen because exp15 release-gate INV
functions averaged ~140 chars body. Longer bodies will produce Tier 1 false-negatives — Tier 3 (`mpl-property-check`,
#112) walks the AST block scope and is the authoritative consumer for C3.

```permitted-when
- the same logical block writes a structured `evidence` entry (file or `state.gate_results.*`) AND emits a non-zero
  exit code on the failing path
```

### M1 · Double-cast escape hatch

- **id**: `M1`
- **category**: `type-safety`
- **severity**: `warn`
- **escalation**: `tier_3_block_in: production` — Tier 1 grep cannot distinguish test vs production from path alone;
  it always emits `warn`. Tier 3 (#112) inspects file path: matches under `**/__tests__/**`, `**/*.test.{ts,tsx,
  js,jsx,mjs}`, or `**/*.spec.{ts,tsx,js,jsx,mjs}` remain `warn`; all other source paths escalate to `block` in
  `enforcement.strict` mode.
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
- the cast is inside a `deepMerge`-style generic-typing utility AND the function is documented as a structural
  bridge across two recursively-typed object trees (current MPL `state-manager.ts:206-248` deepMerge use)
```

### CSP · Missing Content-Security-Policy

- **id**: `CSP`
- **category**: `type-safety`
- **severity**: `warn`
- **escalation**: `tier_3_only` — Tier 3 verifies the response-header layer; Tier 1 catastrophic-backtracking
  hardening means the regex below is intentionally simpler and may produce false-negatives on minified or
  attribute-rich `<html>` tags.
- **rationale**: Renderer HTML handling external content without CSP allows script injection.
- **ground-truth count**: (unmeasured — added beyond exp15 §11 GT set)

```regex
<html\b[^>]*>[\s\S]{0,4000}<body\b
```

The simplified pattern (bounded `[\s\S]{0,4000}` instead of negative-lookahead-per-char) avoids V8 catastrophic
backtracking on inline-style heavy HTML. Tier 1 only flags suspicious `<html>...<body>` blocks; Tier 3 inspects
whether (a) `<head>` contains a `<meta http-equiv="Content-Security-Policy">` or (b) the response header layer
sets CSP.

```permitted-when
- CSP is enforced via response header (`Content-Security-Policy: ...`) confirmed in the same phase's `impact_scope`
- the file is a test fixture or a static demo with no external content
```

### D1.a · Unconditional default-coalesce poisoning

- **id**: `D1.a`
- **category**: `fallback-poison`
- **severity**: `warn`
- **escalation**: `tier_3_block_in: verification-result-LHS` — Tier 1 grep emits `warn` only because it cannot
  distinguish a verification-result LHS from a state-shape tolerance LHS. Tier 3 (#112) inspects the LHS
  identifier name pattern (`result|exit_code|status|passed|failed|verification|gate_result|test_result`) and
  escalates to `block` only when LHS matches.
- **rationale**: `?? ''` / `?? []` / `?? null` on a verification result, exit code, or external response silently
  turns failure into a non-failure neutral value. State-shape tolerance and null-safe rendering are common legitimate
  uses; the danger is when the LHS represents an evaluation outcome.
- **ground-truth count**: 1+ (exp15 release-gate.mjs:152 explicit) — broad pattern with permitted-when narrowing

```regex
\?\?\s*['"]\s*['"]
\?\?\s*\[\s*\]
\?\?\s*null\b
```

```permitted-when
- the LHS is a UI input value AND the default is the documented neutral form (e.g. empty string for an unset name
  field)
- the LHS is a typed union where `undefined` represents an explicit "absent" semantic and the default is exhaustively
  documented in an adjacent comment
- **state-shape tolerance**: the LHS is a state read or null-safe rendering accessor (e.g. `state.foo ?? null` for
  schema migration or backward-compat), AND the enclosing function is documented as a state-comparator, state-shape
  normalizer, or renderer (matches MPL's hooks/lib/mpl-state.mjs migration paths and hooks/mpl-hud.mjs renderer use)
```

### D1.b · Synthetic-ID literal masking absence

- **id**: `D1.b`
- **category**: `fallback-poison`
- **severity**: `block`
- **rationale**: Template-literal synthesis like `\`no-git-${ISO}\`` or `\`unknown-${id}\`` invents an identifier
  when an upstream identity lookup fails, masking the absence. Downstream code cannot distinguish a real ID from a
  synthesized one without parsing the prefix. Different anti-pattern than D1.a (coalesce); split per PR #120
  review #3.
- **ground-truth source**: `release-gate.mjs:152`

```regex
\bno-git-\$\{
\bunknown-\$\{
\bsynthetic-\$\{
\bplaceholder-\$\{
```

```permitted-when
- the synthesized literal is explicitly tagged with a `synthetic_origin` field on the same object literal AND
  downstream consumers branch on that field (e.g. `if (id.startsWith('no-git-')) ...`)
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
\.\s*catch\s*\(\s*_\s*=>\s*(?:false|null|undefined)\b
\.\s*catch\s*\(\s*\(\s*\)\s*=>\s*\{\s*return\s+(?:false|null|undefined)\s*;?\s*\}\s*\)
\.\s*catch\s*\(\s*function\s*\(\s*\)\s*\{\s*return\s+(?:false|null|undefined)
```

```permitted-when
- the catch handler explicitly logs the structured error AND records it to `.mpl/signals/*` or equivalent persistent
  evidence (Tier 3 property-check confirms the named-arg form `.catch((err) => { logger... })` and the presence of
  a write to a signals/log path)
```

---

## Self-application

These patterns apply to MPL plugin source code (`.mjs/.ts/.py/.rs/...`) under `agents/`, `hooks/`, `commands/`,
`skills/`, `mcp-server/src/`. **Markdown files (`.md`) are documentation and excluded from F3/F4 scanning** — that
includes `agents/*.md` agent prompts (which contain literal anti-pattern examples for self-explanation) and this
registry file itself. The exclusion is path-extension based and applied **before** regex compilation; this closes
the self-application contract loop without introducing self-exemption regexes (which would themselves be a
violation pattern surfaced by F4).

When MPL adds a new source file extension to its own codebase (e.g. introduces Python tooling), update `## Scope`
above and re-run the registry against MPL source to surface or exempt new hits.

## How to add a new pattern

1. Add a `### IDx · Title` heading + front-matter bullets + `regex` + `permitted-when` blocks following the schema
   in `## Schema`.
2. Bump `ground-truth count` if measured; otherwise mark `(unmeasured)`.
3. Update the **Ground-truth → registry mapping** table to keep the GT/ID accounting transparent.
4. Update `agents/mpl-phase-runner.md` `<Anti_Patterns_Prohibited>` summary table.
5. Add a fixture pair in `hooks/__tests__/fixtures/anti-pattern-corpus/<id>.{positive,negative}.fixture.<ext>` and
   wire into `hooks/__tests__/mpl-fallback-grep.test.mjs` (#105 F3).
6. Run the registry against the current MPL source (only files matching `## Scope`):
   ```sh
   node hooks/mpl-fallback-grep.mjs --self-check
   ```
   Expected: zero new false positives, OR surface them via `permitted-when` clauses, OR an explicit grace clause
   added to the pattern body with a deadline issue.
