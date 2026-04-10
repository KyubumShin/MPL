# MPL Test Strategy Redesign

> MPL ~70 tests vs Ouroboros 900+ tests — structural cause analysis and improvement design for the 12x gap

## 1. Situation Analysis

### 1.1 Absolute Test Count Comparison (similar project scale)

| Metric | MPL (Yggdrasil) | Ouroboros |
|------|-----------------|----------|
| Generated tests | ~70 | 900+ |
| Test files | ~10 | 95 |
| Test layers | Gate 1 (vitest) | Unit + Integration + E2E |
| AC → test conversion | Agent discretion | Automated code decomposition |
| Test accumulation | Independent per Phase | Monotonically increasing per generation |

### 1.2 Structural Root Causes

#### Cause 1: Insufficient AC Decomposition Density

**Ouroboros's AssertionExtractor**:
```
AC: "API should return 200 for valid input and 400 for invalid input with error message"
  → SpecAssertion 1: T1_constant, pattern="status.*200", file_hint="*.py"
  → SpecAssertion 2: T1_constant, pattern="status.*400", file_hint="*.py"
  → SpecAssertion 3: T2_structural, pattern="error_message", file_hint="*.py"
  = 3 verification points auto-generated
```

**MPL's current state**:
```
A-item: `npx vitest run tests/api.test.ts` -- Expected: exit 0
  → tell mpl-test-agent "test this AC"
  → agent writes 1~2 tests at its discretion
  = depends on agent discretion, decomposition density is inconsistent
```

#### Cause 2: Absence of 4-Tier Verification

Ouroboros **classifies AC into 4 tiers by verifiability**, then applies the appropriate verification method for each tier:

| Tier | Target | Verification Method | Cost |
|------|------|----------|------|
| T1 (Constant) | Config values, constants, thresholds | regex source scan | $0 |
| T2 (Structural) | File/class/interface existence | glob/grep | $0 |
| T3 (Behavioral) | Functional behavior | test execution | test cost |
| T4 (Unverifiable) | Subjective judgment | skip | $0 |

MPL has A/S/H classification but:
- A-item: "does the command return exit 0?" → covers only T3 (behavioral) level
- S-item: BDD scenarios → also T3
- **$0 verification** for T1/T2 is missing

#### Cause 3: Absence of Test Accumulation Mechanism

```
Ouroboros evolve:
  Gen 1: 50 tests → Gen 2: 50 + 30 new = 80 → Gen 3: 80 + 20 = 100
  = regression suite accumulates each generation

MPL phases:
  Phase 1: 15 tests → Phase 2: 12 tests → Phase 3: 18 tests
  = independent per Phase. Is Phase 1 test run as regression in Phase 3? Not guaranteed
```

#### Cause 4: Absence of Mechanical Verification

Ouroboros's Stage 1 (Mechanical) runs lint/build/typecheck/coverage **in code** before test execution.
MPL's 3-Gate is similar but:
- Gate 1: `tsc` → type check only (no lint)
- Gate 2: `vitest` → test execution
- Gate 3: `build` → build

**Missing**: lint, coverage threshold, static analysis

---

## 2. Improvement Design

### 2.1 Overall Architecture Change

```
Current MPL:
  Verification Planner → A/S/H classification → Test Agent (writes tests at agent discretion)
                                           ↓
                                       Gate 1-3

Improved MPL:
  Verification Planner → A/S/H classification
        ↓
  [NEW] Assertion Extractor (MCP: mpl_extract_assertions)
        → automatically decompose AC into T1/T2/T3/T4 SpecAssertions
        → T1/T2 immediately auto-verified (mpl_verify_spec)
        ↓
  Test Agent (handles T3 assertions only → reduced agent burden, increased test density)
        ↓
  [NEW] Regression Accumulator (accumulate tests across Phases)
        ↓
  [ENHANCED] Gate 1-4 (lint + typecheck + test + build + coverage)
```

### 2.2 New MCP Tools (2 added)

#### `mpl_extract_assertions`

Automatically decompose AC into 4-Tier SpecAssertions. Ouroboros `extractor.py` pattern.

```typescript
{
  name: "mpl_extract_assertions",
  description: "Extract machine-verifiable assertions from acceptance criteria (4-tier classification)",
  inputSchema: {
    properties: {
      cwd: { type: "string" },
      acceptance_criteria: {
        type: "array",
        items: { type: "string" },
        description: "List of AC texts (A/S-item descriptions)"
      },
      pivot_points: {
        type: "string",
        description: "List of PPs (for strengthening verification criteria)"
      }
    },
    required: ["cwd", "acceptance_criteria"]
  }
}
```

**Return value:**
```json
{
  "assertions": [
    {
      "ac_index": 0,
      "ac_text": "API should return 200 for valid input",
      "tier": "t3_behavioral",
      "pattern": "",
      "expected_value": "",
      "file_hint": "src/api/**/*.ts",
      "description": "Valid request returns 200 OK"
    },
    {
      "ac_index": 0,
      "ac_text": "API should return 200 for valid input",
      "tier": "t1_constant",
      "pattern": "status.*200|OK",
      "expected_value": "200",
      "file_hint": "src/api/**/*.ts",
      "description": "Status code 200 is referenced in handler"
    },
    {
      "ac_index": 1,
      "ac_text": "Error responses include error_code field",
      "tier": "t2_structural",
      "pattern": "error_code",
      "expected_value": "",
      "file_hint": "src/types/**/*.ts",
      "description": "error_code field exists in error response type"
    }
  ],
  "summary": {
    "total": 12,
    "by_tier": { "t1_constant": 4, "t2_structural": 3, "t3_behavioral": 4, "t4_unverifiable": 1 },
    "auto_verifiable": 7,
    "needs_test": 4,
    "unverifiable": 1
  }
}
```

**Internal logic:**
```typescript
// LLM call (sonnet, temperature 0.0, reproducibility)
// Apply Ouroboros's _SYSTEM_PROMPT pattern:
//   - T1: constants/config values → extract regex pattern
//   - T2: structural existence → file/class/function name pattern
//   - T3: behavioral → requires test execution
//   - T4: subjective → skip
// 1 AC → 0~3 assertions (multiple verification points)
```

**Core value:**
- Dependency on agent discretion → **code-based automated decomposition**
- 1 AC → average 1.5~2.5 assertions → **10 ACs yield 15~25 verification points**

#### `mpl_verify_spec`

Automatically verify T1/T2 assertions against code. No LLM calls, $0 cost.

```typescript
{
  name: "mpl_verify_spec",
  description: "Verify T1/T2 spec assertions against actual source files (regex scan, $0 cost)",
  inputSchema: {
    properties: {
      cwd: { type: "string" },
      assertions: {
        type: "array",
        description: "List of t1/t2 assertions from mpl_extract_assertions return value"
      }
    },
    required: ["cwd", "assertions"]
  }
}
```

**Return value:**
```json
{
  "results": [
    {
      "ac_index": 0,
      "tier": "t1_constant",
      "verified": true,
      "actual_value": "200",
      "file_path": "src/api/handlers/user.ts:45",
      "detail": "Found: res.status(200)"
    },
    {
      "ac_index": 1,
      "tier": "t2_structural",
      "verified": false,
      "actual_value": "",
      "file_path": "",
      "detail": "error_code field not found in any type definition"
    }
  ],
  "summary": {
    "total_checked": 7,
    "verified": 5,
    "failed": 2,
    "pass_rate": 71.4,
    "discrepancies": [
      { "ac_index": 1, "agent_said": "pass", "spec_says": "fail", "detail": "..." }
    ]
  }
}
```

**Internal logic** (Ouroboros `verifier.py` pattern):
```typescript
// T1: scan source files with regex pattern
//   - collect file list with file_hint glob
//   - match pattern in each file
//   - compare expected_value with actual value

// T2: confirm file/class/function existence
//   - confirm file existence with file_hint glob
//   - grep class/function name with pattern

// Security: MAX_FILE_SIZE(50KB), MAX_PATTERN_LENGTH(200), ReDoS prevention
```

### 2.3 Verification Planner Expansion

Add **T1/T2/T3/T4 sub-classification** to existing A/S/H classification.

```
Current:
  AC → A-item (command-based) / S-item (BDD) / H-item (human)

Improved:
  AC → call mpl_extract_assertions
     → T1/T2 assertions: immediately auto-verify with mpl_verify_spec
     → T3 assertions: classify as A-item or S-item → Test Agent writes tests
     → T4 assertions: classify as H-item
```

**Verification Planner output change:**

```markdown
## 2. A-items (Agent-Verifiable)
### T1 Auto-Verified (spec scan, $0)
- [A-1] Phase 1: `CACHE_TTL=300` in config.ts -- ✅ Verified: config.ts:12
- [A-2] Phase 1: `MAX_RETRIES=3` in retry.ts -- ✅ Verified: retry.ts:5

### T2 Auto-Verified (structural check, $0)
- [A-3] Phase 1: `UserSchema` type exists -- ✅ Verified: types/user.ts:8
- [A-4] Phase 2: `AuthMiddleware` class exists -- ❌ Not found

### T3 Test-Required (Test Agent handles)
- [A-5] Phase 1: `npx vitest run tests/cache.test.ts` -- Expected: exit 0
- [A-6] Phase 2: `npx vitest run tests/auth.test.ts` -- Expected: exit 0
```

### 2.4 Test Agent Role Change

**Before:** Test all ACs at agent discretion
**After:** Focus only on T3 assertions → **deeper tests, higher density**

```
Current:
  Test Agent input: "test all ACs for this Phase"
  → agent interprets ACs + designs tests + writes + runs
  → result: ~7 tests/phase (agent discretion)

Improved:
  Test Agent input:
    - T3 assertion list (already concretely decomposed)
    - T1/T2 verification results (already automatically completed)
    - "write a test for each T3 assertion"
  → 1~2 tests per assertion (decomposition density guaranteed)
  → result: ~15-20 tests/phase (assertion-based)
```

### 2.5 Test Accumulation Policy (Regression Accumulator)

Introduce a mechanism for tests to accumulate across Phases.

```
Phase 1 complete: 15 tests → register in .mpl/regression-suite.json
Phase 2 start: run Phase 2 tests + Phase 1 regression suite
Phase 2 complete: 15 + 12 = 27 tests in regression suite
Phase 3 start: run Phase 3 tests + 27 regression tests
...
Phase N complete: accumulated tests monotonically increase
```

**regression-suite.json structure:**
```json
{
  "accumulated_tests": [
    {
      "phase": "phase-1",
      "test_files": ["tests/cache.test.ts", "tests/types.test.ts"],
      "test_command": "npx vitest run tests/cache.test.ts tests/types.test.ts",
      "added_at": "2026-03-15T10:00:00Z",
      "assertion_count": 15
    },
    {
      "phase": "phase-2",
      "test_files": ["tests/auth.test.ts"],
      "test_command": "npx vitest run tests/auth.test.ts",
      "added_at": "2026-03-15T11:00:00Z",
      "assertion_count": 12
    }
  ],
  "total_assertions": 27,
  "regression_command": "npx vitest run tests/cache.test.ts tests/types.test.ts tests/auth.test.ts"
}
```

**Gate 2 change:**
```
Current Gate 2: run only current Phase tests
Improved Gate 2: run current Phase tests + full regression suite
```

### 2.6 Gate Expansion (4-Gate)

| Gate | Current | Improved |
|------|------|------|
| Gate 1 | `tsc` (type check) | `tsc` + lint (ruff/eslint) |
| Gate 2 | `vitest` (current Phase only) | `vitest` (current Phase + regression suite) |
| Gate 3 | `build` | `build` + **coverage threshold** (>= 70%) |
| Gate 4 | none | **Spec Verification** (`mpl_verify_spec` T1/T2 auto-verification) |

Gate 4 is $0 cost (no LLM calls, regex scan only). But cross-verifies agent's "I've implemented it" in code.

---

## 3. Expected Impact

### 3.1 Test Count Projection

Based on same scale as Yggdrasil (AC ~30, 7 Phases):

| Stage | Current | After Improvement |
|------|------|--------|
| AC decomposition | 30 ACs → ~30 verification points | 30 ACs → ~60-75 SpecAssertions |
| T1/T2 auto-verification | 0 | ~25-30 (immediate, $0) |
| T3 test generation | ~70 (all) | ~35-45 (T3 only, more focused) |
| Regression accumulation | none (independent per Phase) | 7 Phases × ~10 = 70 regression tests |
| **Total verification points** | **~70** | **~130-145 + 70 regression = ~200** |

3x increase. Cannot reach 900, but the key difference:
- Ouroboros's 900 are the project's own unit tests (accumulated via evolve loop)
- MPL generates "tests for the user's project" so a direct comparison is inappropriate
- **Verification density per AC** (assertion/AC) is the key metric: current ~2.3 → after improvement ~5-7

### 3.2 Quality Improvements

| Metric | Current | After Improvement |
|------|------|--------|
| False positives (agent says pass but actually fails) | Undetectable | Detectable with T1/T2 cross-verification |
| AC coverage | Agent discretion | All ACs have at least 1 assertion |
| Regression | Independent per Phase | Cumulative regression suite |
| Verification cost | All LLM cost | T1/T2 at $0, only T3 uses LLM |

---

## 4. Implementation Order

```
Phase 1: Add MCP tools (mpl_extract_assertions, mpl_verify_spec)
  → Add to tool list in mcp-server-design.md (total 9 tools)

Phase 2: Improve Verification Planner agent
  → A/S/H + T1/T2/T3/T4 sub-classification output
  → Integrate mpl_extract_assertions calls

Phase 3: Change Test Agent role
  → Switch to T3 assertion-based test writing
  → Lighten agent prompt

Phase 4: Regression Accumulator + Gate 4
  → Manage regression-suite.json
  → Integrate regression into Gate 2
  → Add Gate 4 (Spec Verification)

Phase 5: Update agent prompts
  → mpl-decomposer.md: add T1/T2/T3/T4 classification *(was mpl-verification-planner, removed v0.11.0)*
  → mpl-phase-runner.md: switch to T3 assertion basis *(was mpl-test-agent, removed v0.11.0)*
  → mpl-run-execute.md: reflect Gate 4 + regression
```

---

## 5. Differences from Ouroboros

MPL adopts Ouroboros's **verification density mechanism** without bringing over the entire structure wholesale.

| Domain | Ouroboros | MPL Adaptation |
|------|----------|---------|
| Assertion decomposition | `extractor.py` (Python) | `mpl_extract_assertions` MCP tool (TypeScript) |
| Spec verification | `verifier.py` (regex scan) | `mpl_verify_spec` MCP tool (regex scan) |
| 3-Stage Evaluation | Mechanical → Semantic → Consensus | Gate 1-4 (lint/typecheck/test+regression/build+coverage/spec) |
| Evolve Loop | Per-generation test accumulation | Per-Phase regression suite accumulation |
| Multi-Model Consensus | GPT-4o + Claude + Gemini voting | Not adopted (MPL uses PP-based verification as replacement) |
| Devil's Advocate | Intentional counter-argument agent | Not adopted (future consideration) |

MPL's **PP-based coherence guarantee** serves as a replacement for Ouroboros's Consensus.
PP violation detection + Side Interview is a mechanism that ensures verification quality without Multi-Model Consensus.
