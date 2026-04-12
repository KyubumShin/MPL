# Adaptive Pipeline Router — Implementation Plan

> **⚠ v2 이후 Deprecated**: Hat model(pp_proximity)로 대체됨. 역사적 참조용.

> Implementation plan for F-20, F-21, F-22. Based on Ouroboros PAL Router analysis.
> Written: 2026-03-07

---

## Goal

**When the user types just "mpl", the system automatically selects the optimal pipeline and expands if needed during execution.**

Current 3 skills (mpl, mpl-small, mpl-bugfix) → unified into a single "mpl" entry point.

---

## Implementation Phases

### Phase 1: Quick Scope Scan + Pipeline Score (F-20 core)

**Goal**: Automatically determine `pipeline_tier` in Triage (Step 0)

#### 1-1. Create `hooks/lib/mpl-scope-scan.mjs`

Quick Scope Scan utility. Rather than the orchestrator calling it at Triage time, this is the **official definition referenced by keyword-detector or Triage protocol**.

```javascript
// Input: user prompt + cwd
// Output: { pipeline_score, pipeline_tier, scan_evidence }

// pipeline_score formula:
// (file_scope × 0.35) + (test_complexity × 0.25)
//   + (dependency_depth × 0.25) + (risk_signal × 0.15)

// Quick Scope Scan is performed by the orchestrator with Glob/Grep (built-in tools)
// This module handles score calculation logic only
```

Implementation scope:
- `calculatePipelineScore(scanResult)` — pure function for score calculation
- `classifyTier(score, hint)` — tier classification (overrides if hint is provided)
- `formatScanEvidence(scanResult, score, tier)` — generate evidence string

#### 1-2. Modify `commands/mpl-run.md` Triage Section

Add Quick Scope Scan + pipeline_tier determination procedure to Step 0 Triage:

```markdown
### Step 0: Triage (expanded)

1. Information density analysis → interview_depth (existing)
2. **Quick Scope Scan** (new, ~1-2K tokens):
   a. Glob("**/*.{ts,tsx,js,jsx,py,go,rs}") → confirm project file count
   b. Files/modules mentioned in user prompt → confirm existence with Grep → estimate affected_files
   c. Test file presence → Glob("**/*.test.*", "**/*_test.*", "**/test_*")
   d. Import depth of mentioned modules → Grep("import|require", affected_files) 1-hop
3. **Calculate pipeline_score** → pipeline_tier
4. routing-patterns.jsonl matching (F-22, implemented in Phase 3)
5. Record pipeline_tier in state.json
```

#### 1-3. Create `commands/mpl-run-triage.md`

Detailed protocol dedicated to Triage. Clearly defines branching logic by tier:

```markdown
## Tier-based Pipeline Branching

After pipeline_tier is determined, select subsequent steps to match the tier:

### Frugal (score < 0.3)
- Skip: PP interview, Pre-Execution Analysis, Decomposition, Gate 2/3
- Do: Error Spec (Phase 0 Step 4) → single Fix Cycle → Gate 1 → Commit
- Orchestrator protocol: load mpl-run-frugal.md

### Standard (0.3 ≤ score < 0.65)
- Skip: Full PP (→light), Phase 0 Steps 1-3, multi-phase decomposition, Gate 2/3
- Do: PP (light) → Error Spec → single Phase execution → Gate 1 → Commit
- Orchestrator protocol: load mpl-run-standard.md

### Frontier (score ≥ 0.65)
- Skip: none
- Do: full 9+ step pipeline
- Orchestrator protocol: mpl-run.md (existing)
```

#### 1-4. Modify `hooks/mpl-keyword-detector.mjs`

Unify 3-way branching into a single entry point:

```javascript
// Before:
const isSmallRun = /\bmpl[\s-]*(small|quick|light)\b/i.test(cleanPrompt);
const skillName = isSmallRun ? 'mpl-small' : 'mpl';

// After:
const tierHint = extractTierHint(cleanPrompt);
// "bugfix|fix|bug" → "frugal"
// "small|quick|light" → "standard"
// none → null (auto)
initState(cwd, featureName, 'auto', tierHint);
const skillName = 'mpl'; // always single skill
```

#### 1-5. Modify `hooks/lib/mpl-state.mjs`

Add `pipeline_tier` and `tier_hint` fields to state.json:

```json
{
  "run_mode": "auto",
  "pipeline_tier": null,
  "tier_hint": "frugal",
  "escalation_history": []
}
```

`pipeline_tier` is set by the orchestrator after Triage completes. `tier_hint` is set by keyword-detector.

#### Deliverables

| File | Change Type | Description |
|------|----------|------|
| `hooks/lib/mpl-scope-scan.mjs` | New | pipeline_score calculation logic |
| `commands/mpl-run-triage.md` | New | Triage extended protocol (branching by tier) |
| `commands/mpl-run-frugal.md` | New | Frugal tier orchestration protocol |
| `commands/mpl-run-standard.md` | New | Standard tier orchestration protocol |
| `commands/mpl-run.md` | Modified | Add Quick Scope Scan to Step 0 Triage, tier-based protocol load branching |
| `hooks/mpl-keyword-detector.mjs` | Modified | Unified single entry point |
| `hooks/lib/mpl-state.mjs` | Modified | Add pipeline_tier, tier_hint fields |
| `skills/mpl/SKILL.md` | Modified | Add tier recognition logic |

---

### Phase 2: Dynamic Escalation (F-21)

**Goal**: Automatically switch to a higher tier upon circuit break

#### 2-1. Define Escalation Protocol

Add escalation section to `commands/mpl-run-triage.md`:

```markdown
## Escalation Protocol

### Frugal → Standard Escalation
Trigger: circuit break in Frugal Fix Cycle (3 retry failures)
Procedure:
1. Preserve completed TODO list (record in state.json)
2. Change state.json pipeline_tier to "standard"
3. Record in escalation_history
4. Extract PP (light) — extract directly from prompt
5. Reuse Error Spec (already generated)
6. Reorganize failed task as single Phase TODO
7. Re-run with Standard protocol

### Standard → Frontier Escalation
Trigger: circuit break in Standard Phase
Procedure:
1. Preserve completed TODOs/Phases
2. Change state.json pipeline_tier to "frontier"
3. Record in escalation_history
4. Run Full PP interview (expand based on existing light PP)
5. Run Phase 0 Enhanced (add Steps 1-3 beyond Error Spec)
6. Decompose failed task into multiple phases with mpl-decomposer
7. Re-run with Frontier protocol

### If Frontier also fails
Apply existing circuit break → phase5-finalize protocol (no change)
```

#### 2-2. Modify `hooks/mpl-phase-controller.mjs`

Add logic to check escalation availability on circuit break event:

```javascript
// On circuit break detection:
// 1. Check current pipeline_tier
// 2. If frugal or standard → return escalation message
// 3. If frontier → existing circuit break → phase5-finalize handling
```

#### 2-3. Modify `hooks/lib/mpl-state.mjs`

Add escalation-related functions:

- `escalateTier(cwd)` — transition current tier → next tier + record history
- `getEscalationTarget(cwd)` — return next tier (null if frontier)
- `recordEscalation(cwd, from, to, reason, preservedWork)` — append to history

#### Deliverables

| File | Change Type | Description |
|------|----------|------|
| `commands/mpl-run-triage.md` | Modified | Add Escalation Protocol section |
| `hooks/mpl-phase-controller.mjs` | Modified | circuit break → escalation branching |
| `hooks/lib/mpl-state.mjs` | Modified | escalateTier, getEscalationTarget functions |

---

### Phase 3: Routing Pattern Learning (F-22)

**Goal**: Accumulate execution results to optimize the initial tier for the next run

#### 3-1. Create `hooks/lib/mpl-routing-patterns.mjs`

```javascript
// append: record pattern on execution completion
function appendPattern(cwd, { description, tier, escalated, result, tokens, files })

// match: search for similar patterns at Triage time
function findSimilarPattern(cwd, description, threshold = 0.8)

// jaccard: calculate similarity after tokenization
function jaccardSimilarity(desc1, desc2)
```

#### 3-2. Modify `commands/mpl-run-triage.md`

Add pattern matching step to Triage Step 0:

```markdown
4. **Routing Pattern Matching** (F-22):
   a. Load `.mpl/memory/routing-patterns.jsonl`
   b. Compare Jaccard similarity with user prompt
   c. If pattern with similarity ≥ 0.8 exists → recommend that pattern's tier
   d. If recommended tier differs from pipeline_score by 2+ levels → score takes priority
   e. Record "pattern_match" in scan_evidence when recommendation is applied
```

#### 3-3. Modify `commands/mpl-run-finalize.md`

Add pattern recording step to Step 5 Finalize:

```markdown
### Step 5.4.5: Routing Pattern Recording (F-22)
Append execution results to `.mpl/memory/routing-patterns.jsonl`:
- Task description (user prompt summary)
- Final pipeline_tier (final tier if escalated)
- Whether escalated and original tier
- Success/failure
- Total token usage
- Number of affected files
```

#### Deliverables

| File | Change Type | Description |
|------|----------|------|
| `hooks/lib/mpl-routing-patterns.mjs` | New | Pattern recording/matching/similarity logic |
| `commands/mpl-run-triage.md` | Modified | Add pattern matching step |
| `commands/mpl-run-finalize.md` | Modified | Add pattern recording step |

---

## Implementation Order and Dependencies

```
Phase 1 (F-20): Quick Scope Scan + Pipeline Score
  ├─ 1-5. mpl-state.mjs (add tier fields)           ← foundation
  ├─ 1-1. mpl-scope-scan.mjs (score calculation)    ← independent
  ├─ 1-4. keyword-detector.mjs (single entry point) ← depends on 1-5
  ├─ 1-3. mpl-run-triage.md (tier branching)        ← depends on 1-1
  │   ├─ mpl-run-frugal.md (new protocol)
  │   └─ mpl-run-standard.md (new protocol)
  └─ 1-2. mpl-run.md (modify Step 0)                ← depends on 1-3

Phase 2 (F-21): Dynamic Escalation
  ├─ 2-3. mpl-state.mjs (escalation functions)      ← after Phase 1 complete
  ├─ 2-2. mpl-phase-controller.mjs (add branching)  ← depends on 2-3
  └─ 2-1. mpl-run-triage.md (escalation section)    ← depends on 2-3

Phase 3 (F-22): Routing Pattern Learning
  ├─ 3-1. mpl-routing-patterns.mjs (pattern logic)  ← after Phase 1 complete
  ├─ 3-2. mpl-run-triage.md (matching step)         ← depends on 3-1
  └─ 3-3. mpl-run-finalize.md (recording step)      ← depends on 3-1
```

Phase 2 and Phase 3 can proceed in parallel after Phase 1 is complete.

---

## Validation Plan

### Phase 1 Validation

| Validation Item | Method | Pass Criteria |
|----------|------|----------|
| Score calculation accuracy | mpl-scope-scan.mjs unit tests | Correct tier classification in 3 scenarios (frugal/standard/frontier) |
| keyword-detector integration | Test inputs "mpl bugfix X", "mpl small X", "mpl X" | All enter single skill, tier_hint set correctly |
| Triage expansion | Run mpl on real project | pipeline_tier recorded in state.json |
| Frugal protocol | Simple bug fix task | Equivalent result to mpl-bugfix, ~5-15K tokens |
| Standard protocol | Small feature addition task | Equivalent result to mpl-small, ~20-40K tokens |

### Phase 2 Validation

| Validation Item | Method | Pass Criteria |
|----------|------|----------|
| Frugal→Standard escalation | Intentionally start complex task with bugfix hint | Automatic Standard switch after circuit break, completed TODOs preserved |
| Standard→Frontier escalation | Induce failure in medium-complexity task | Automatic Frontier switch, light PP expanded to full PP |
| Escalation history | Inspect state.json | Transition record exists in escalation_history |

### Phase 3 Validation

| Validation Item | Method | Pass Criteria |
|----------|------|----------|
| Pattern recording | Check routing-patterns.jsonl after execution completes | Appended in correct format |
| Similarity matching | Re-run with similar task description | Previous pattern's tier is recommended |
| Jaccard accuracy | Unit tests | Same sentence = 1.0, completely different sentence = 0.0 |

---

## Backward Compatibility

| Existing Feature | Impact | Response |
|----------|------|------|
| `/mpl:mpl-bugfix` skill | **Deprecated** | Redirect to tier_hint="frugal". Add deprecation notice to SKILL.md |
| `/mpl:mpl-small` skill | **Deprecated** | Redirect to tier_hint="standard". Add deprecation notice to SKILL.md |
| `/mpl:mpl` skill | Maintained | Add tier recognition logic |
| `mpl-keyword-detector.mjs` | Modified | Existing "mpl small", "mpl bugfix" keywords still recognized but used as hint only |
| `state.json` format | Fields added | Add pipeline_tier, tier_hint, escalation_history. Preserve existing fields |
| `mpl-run.md` | Modified | Add Quick Scope Scan to Step 0, tier-based protocol load branching |

---

## References

- [Ouroboros PAL Router](https://github.com/Q00/ouroboros) — `src/ouroboros/routing/` (router.py, complexity.py, tiers.py, escalation.py, downgrade.py)
- Ouroboros Complexity Score: `(token × 0.30) + (tool × 0.30) + (ac_depth × 0.40)`
- Ouroboros Escalation: 2 consecutive failures → next tier, counter resets on success
- Ouroboros Downgrade: 5 consecutive successes → previous tier, pattern inheritance with Jaccard similarity 0.8
- MPL design.md §3.2 (Triage), §3.3 Step 0.5 (maturity mode)
