---
id: AD-0008
title: E2E Scenario Upfront Design + Finalize Enforcement
status: accepted
date: 2026-04-19
related: ["AD-0006", "AD-0007", "HA-06", "#44"]
---

## Context

ygg-exp11 (Opus 4.7, v0.14.1) produced **42 of 80 E2E specs committed as `TODO(segment-7-integration-ci)` skip stubs** — scenarios existed as placeholders but never executed. HA-06's single `e2e_command` field captured only "does the project require E2E?" (boolean) and the command string, with no **scenario content** decided until the last phase. The orchestrator improvised scenarios ad hoc at finalize and skipped the hard ones.

Observed root causes:

1. **No upfront scenario design.** Decomposition produced one E2E S-item on the final phase ("E2E smoke test passes"); the content was decided by the phase-runner at the moment of writing test code.
2. **No scenario-level evidence.** `state.e2e_command` is a single string; there's no per-scenario exit_code record, so finalize cannot detect partial coverage.
3. **No cross-feature linkage to PPs.** Scenarios didn't anchor to Pivot Points, so "must-work user journeys" had no structural protection.
4. **No infrastructure readiness check.** E2E infra (playwright install, config, smoke app) was expected to just exist; when absent, scenarios degraded to `TODO` commits.

AD-0006 (v0.15.0) fixed **measurement** of existing commands; AD-0007 (v0.15.1) fixed **test-agent** invocation. AD-0008 fixes the **scenario layer above** — what should be tested before release and how to enforce it.

## Decision

### 1. Two-stage scenario artifact

Scenarios live in **two separate yaml files** to reflect their different ownership and lifecycle:

**`.mpl/mpl/core-scenarios.yaml`** — Phase 0 Enhanced output, immutable after Phase 0 approval.
```yaml
core_scenarios:
  - id: CORE-1
    pp_ref: PP-1                       # single PP anchor (N:1 allowed for multi-PP flows)
    title: string                       # human-readable
    user_story: string                  # one sentence from user POV
    flow:                               # ordered steps from user-facing perspective
      - "앱 실행"
      - "프로젝트 생성 버튼 클릭"
      - "이름 입력 → 생성"
      - "캔버스 렌더링 확인"
    must_work: true                     # PP invariant — always required
    acceptance:                         # observable post-conditions
      - "프로젝트 메타 파일 생성됨"
      - "캔버스 DOM 노출"
    source: "phase0_enhanced_hitl"      # provenance marker
```

**`.mpl/mpl/e2e-scenarios.yaml`** — Decomposer output, re-generated on re-decompose.
```yaml
e2e_scenarios:
  - id: E2E-1
    composed_from: [CORE-1, CORE-3]    # 2+ cores preferred (cross-feature)
    title: string
    user_story: string
    phases_involved: [phase-1, phase-3, phase-9]   # required phase set for this scenario
    test_command: "pnpm playwright test e2e/scenario-1.spec.ts"  # executable
    acceptance_criteria: "exit 0 + chapter 내용 재렌더링 확인"
    required: true                      # default true when composed_from contains must_work core
    rationale: string                   # why this composition matters
```

**Why two files**: core-scenarios are PP-anchored invariants (change rarely, require HITL to modify). e2e-scenarios are decomposition-derived (can regenerate without re-interviewing PPs). Separation matches existing MPL layering: `pivot-points.md` (immutable) vs `decomposition.yaml` (regenerable).

### 2. Core derivation — Phase 0 Enhanced sub-step

`commands/mpl-run-phase0-analysis.md` Step 2.5 gains a new sub-step **Step 2.5.3: Core Scenario Derivation** that runs AFTER Phase 0 Enhanced artifact generation and BEFORE Step 4 Verification Command Capture:

```
For each Confirmed PP in .mpl/pivot-points.md:
  AskUserQuestion(
    question: "PP-{N} ({pp.title})이 동작한다는 것은 어떤 사용자 flow를 의미하나요?",
    header: "Core Scenario — PP-{N}",
    options: [
      { label: "단일 core scenario", description: "...하나의 flow로 충분" },
      { label: "복수 core scenarios", description: "...여러 flow로 분리 필요" },
      { label: "PP는 invariant만, scenario 불필요", description: "테스트 대상 flow가 없는 개념적 PP" }
    ]
  )
  // For each scenario the user describes, collect flow steps via follow-up free-text
  // Record to core-scenarios.yaml
```

HITL이 결정적이라 LLM 합리화 불가. 각 PP의 core는 사용자가 직접 확정.

### 3. E2E derivation — Decomposer guided expansion

`agents/mpl-decomposer.md` prompt update (not schema — output field only):

```
Step 7.5 (v0.15.2, AD-0008): E2E Scenario Composition

Read .mpl/mpl/core-scenarios.yaml.

Rule: every e2e_scenario must compose ≥2 core scenarios that span ≥2 phases.
Exception: a core scenario itself may become a 1:1 e2e_scenario when its flow is
complex enough to warrant dedicated integration test (must have ≥3 flow steps
AND touch ≥2 phase impact files).

Emit to .mpl/mpl/e2e-scenarios.yaml per AD-0008 schema.

Infrastructure detection: scan provided-specs + decomposition for E2E stack.
  - If project has no E2E runner (no playwright/cypress/wdio in package.json or
    Cargo.toml, no existing e2e/ directory), INSERT a new phase before the
    first phase that would exercise a scenario:
      id: "phase-e2e-infra"
      name: "E2E Infrastructure Setup"
      phase_domain: "test"
      test_agent_required: false  # infra-only, no API surface
      test_agent_rationale: "Tooling setup — no code path to verify"
      success_criteria:
        - "playwright config 존재, smoke run 성공"
        - "e2e/ 디렉토리 구조 준비"
      impact: ["playwright.config.ts", "e2e/smoke.spec.ts", "package.json"]
  - This guarantees test_command fields in e2e-scenarios.yaml are executable
    at finalize time.
```

### 4. Gate-recorder extension — e2e_results

`hooks/mpl-gate-recorder.mjs` gains a fourth responsibility:

```
If Bash command matches one of the e2e_scenarios[].test_command entries:
  state.e2e_results[scenario.id] = { command, exit_code, stdout_tail, timestamp }
```

The scenario test_command acts as the matching key (exact string match on the
first token+args). No new classification heuristic needed; scenarios are
self-declared.

### 5. Finalize Step 5.0 — scenario loop

`commands/mpl-run-finalize.md` Step 5.0 (replaces current single-command execution):

```
scenarios = Read(".mpl/mpl/e2e-scenarios.yaml").e2e_scenarios
required = scenarios.filter(s => s.required != false)
results = state.e2e_results || {}
override = Read(".mpl/config/e2e-scenario-override.json") or {}

for s in required:
  if override[s.id] or override["*"]:
    continue
  if not results[s.id] or results[s.id].exit_code != 0:
    # scenario never ran OR ran and failed
    Bash(s.test_command)
    # gate-recorder records results[s.id] during this execution
    final = state.e2e_results[s.id]
    if not final or final.exit_code != 0:
      # still failing — escalate to HITL
      AskUserQuestion(
        question: "E2E {s.id} ({s.title}) 실패. 어떻게 처리할까요?",
        header: "E2E 실패",
        options: [
          { label: "재시도", description: "스크립트 수정 후 재실행" },
          { label: "Override 추가", description: ".mpl/config/e2e-scenario-override.json에 사용자 사유와 함께 bypass 등록" },
          { label: "파이프라인 실패 처리", description: "finalize_done=false, 사용자가 수동 개입" }
        ]
      )
      record user's decision in RUNBOOK, then either retry/skip/fail
```

HITL은 failure에서만 trigger — 성공/override는 silent.

### 6. Hook enforcement — finalize_done guard

New hook `hooks/mpl-require-e2e.mjs` (PreToolUse on Write|Edit targeting `.mpl/state.json`):

```
If the write is setting finalize_done: true:
  Load e2e-scenarios.yaml required subset
  For each scenario: check state.e2e_results[id].exit_code == 0 OR override[id]
  Missing or failing → emit {continue: false, decision: "block", reason: ...}
```

Guards against finalize block being skipped by malformed prompt interpretation.
Following the AD-0007 pattern exactly.

### 7. Override config

`.mpl/config/e2e-scenario-override.json` — identical shape to AD-0007's test-agent-override:

```json
{
  "E2E-3": "reason: environment-only scenario, manually QA'd by kbshin on 2026-04-20",
  "*": "project-wide bypass (anti-pattern, audit warning)"
}
```

### 8. Doctor audit — Category 13 [h]

New check added to `/mpl:mpl-doctor audit`:

```
[h] E2E scenario coverage (AD-0008):
  - Required E2E count vs passed E2E count (state.e2e_results)
  - Scenarios with test_command matching "TODO"/"FIXME"/"manual" → FAIL
  - Scenarios whose test_command doesn't exist as a file (for playwright spec paths) → WARN
  - core_scenarios without corresponding e2e_scenarios → WARN (orphaned core)
  - "*" blanket override → WARN anti-pattern
```

## Alternatives Considered

### A. Single yaml (e2e-scenarios only, no core layer)
Simpler but loses PP → scenario traceability. Re-running Phase 0 would regenerate scenarios from scratch, losing user-approved flows. **Rejected.**

### B. specpill MCP integration as primary
specpill has a richer Feature/FlowNode/UIElement model that maps naturally. **Rejected for this release** — adds MCP dependency, couples MPL to a specific tool. Current decision keeps yaml SSOT; future AD can add specpill as optional import/export format.

### C. Decomposer auto-derives core without HITL
Faster but risks missing the "must-work" judgement. Phase 0 Enhanced HITL already runs; adding one more sub-step is cheap. **Rejected.**

### D. E2E infra as project prerequisite (not auto-inserted)
Would fail loudly when infra missing. **Rejected** — too brittle for greenfield. Auto-insertion is safer default; advanced users can provide their own infra (Decomposer detects and skips auto-insertion).

## Cost Impact (exp11-extrapolated)

- Phase 0 Enhanced HITL sub-step: +5-10 AskUserQuestion per PP × ~5 PPs = 25-50 additional interview prompts (human-side cost, not token)
- Decomposer prompt expansion: ~500 tokens (minor)
- E2E infra phase auto-insertion: 1 extra phase when project lacks E2E runner
- Scenario execution at finalize: N playwright runs × avg 30s = significant wallclock but bounded
- HITL on failure: variable, user-driven

Accepted per MPL quality > efficiency invariant. Cost overhead is 1-2 hours of wallclock at most; mitigates the exp11 pattern of 42/80 E2E placeholders reaching release.

## Success Criteria

On next full-pipeline experiment (exp12+):

| Check | Target | Doctor |
|---|---|---|
| core_scenarios count vs Confirmed PPs | 1:1 or N:1 mapping | audit `[h]` |
| e2e_scenarios with `test_command == "TODO*"` | 0 | `[h]` FAIL |
| Required e2e_scenarios executed AND exit 0 | 100% minus explicit overrides | `[h]` FAIL |
| Scenarios composed_from ≥2 cores | ≥80% of e2e_scenarios | `[h]` WARN if below |
| finalize_done=true with failing/missing scenario | 0 (hook must block) | `[h]` FAIL |

## Rollback

If exp12 shows:
- HITL interview overhead doubles Phase 0 time → consider batch-style interview (all PPs at once)
- Infrastructure auto-insertion breaks 2+ real projects → revert to explicit `e2e_required` flag
- Hook false-positives on legitimate finalize writes → add auto-override for dev-only pipelines

## Resolved Questions

### R-1 (was Q-OPEN-1): Core scenario immutability

**Decision**: core-scenarios are IMMUTABLE after Phase 0 approval, inheriting the Pivot Point invariant. PPs cannot change mid-pipeline; neither can core-scenarios. The ONLY way to modify either is **full Phase 0 re-interview**, which regenerates both PP list and core-scenarios atomically.

Implications for implementation:
- `.mpl/mpl/core-scenarios.yaml` has NO `updated_at` field (single `generated_at` timestamp tied to Phase 0 approval)
- No partial edits from Decomposer or phase-runner — only Phase 0 writes this file
- `hooks/mpl-sentinel-pp-file.mjs` (existing PP guard) extends to also block writes to `core-scenarios.yaml` post-approval
- Re-interview command (`/mpl:mpl-pivot` or equivalent) must regenerate both files or neither

### R-2 (was Q-OPEN-2): HITL failure decisions persist as learned overrides

**Decision**: when HITL resolves an E2E failure with "Override 추가" option, the reason is written to `.mpl/config/e2e-scenario-override.json` with an environment marker. Subsequent pipeline runs read this file and auto-apply the override without re-prompting the user, UNLESS the scenario's `test_command` changes (detected by string match).

Override entry shape (extended from AD-0007 base):
```json
{
  "E2E-3": {
    "reason": "Playwright가 CI 환경에서만 실행 가능 — 로컬 dev에서는 skip",
    "test_command_hash": "sha1-of-test-command-at-override-time",
    "recorded_at": "2026-04-20T10:00:00Z",
    "source": "hitl_failure_resolution"
  },
  "*": "project-wide blanket bypass (anti-pattern)"
}
```

Implementation:
- HITL "Override 추가" writes the extended shape
- `hooks/mpl-require-e2e.mjs` + finalize Step 5.0 read either shape (legacy string value OR object with `reason` field)
- If `test_command_hash` mismatches current scenario's test_command, override is IGNORED (prompt user again — the scenario changed, previous override may no longer apply)
- doctor audit `[h]` warns on overrides older than 30 days (stale environment assumption)

Backward compatibility with AD-0007: test-agent-override.json accepts both shapes. AD-0008 e2e-scenario-override extends the pattern; AD-0007 remains simpler (no test_command_hash since phase impact files are the "version" and decomposition regeneration creates new phase ids anyway).
