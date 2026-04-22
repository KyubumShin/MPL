---
description: MPL Phase 0 Protocol - Pre-flight, Interview Block, Codebase Analysis, Ambiguity Resolution, Baseline Snapshot
---

# MPL Phase 0: Pre-Execution Analysis (v0.17 — simplified)

This file covers **Step 0 through Step 2.9** of the MPL orchestration protocol.
Load this when `current_phase` is in the pre-execution stages (before decomposition).

**Structural changes vs v0.16** (see issue #55):
- Removed: Step -1 LSP warm-up (moved to `hooks/mpl-lsp-warmup.mjs`), Step 0.0.5 artifact freshness + field classification, Step 0.1 Quick Scope Scan + pp_proximity, Step 0.1.5a F-22 routing pattern matching, Step 0.2 interview_depth (light/full dual-track), Step 1-B Pre-Exec gap/tradeoff, Uncertainty Scan (3×3 cross-axis).
- Moved: Core Scenarios (ex-Step 3 in phase0-analysis.md) → Stage 1.1. Intent Invariants (ex-Step 3.6) → Stage 1.2. User Contract (ex-Step 1.5) → Stage 1.3. Stage 2 Ambiguity Resolution Loop → after Step 2 Codebase (so `codebase_context` is populated).
- Added: Step 2.9 Branch Main State Snapshot (baseline.yaml) — immutable ground-truth checkpoint after Stage 2 closes.

---

## Step 0: Pre-flight (inline, ~15L)

Three lightweight tasks run in sequence at pipeline start.

### 0.1: Tool Mode Classification (F-04)

Determine available static-analysis tools. Hook `mpl-lsp-warmup.mjs` has already fired asynchronously on UserPromptSubmit — read its result from state.

```
lsp_available = (state.lsp_servers ?? []).length > 0

try:
  ast_grep_search(pattern="$X", language=detected_language)
  ast_grep_available = true
catch:
  ast_grep_available = false

if lsp_available AND ast_grep_available:
  tool_mode = "full"
elif lsp_available:
  tool_mode = "partial"
else:
  tool_mode = "standalone"

writeState(cwd, { tool_mode: tool_mode })
Announce: "[MPL] Tool mode: {tool_mode}."
```

All subsequent Phase 0 steps check `tool_mode` before using LSP/ast_grep tools. If `standalone` or `partial`, use fallbacks in `docs/standalone.md`.

### 0.2: RUNBOOK Initialization (F-10)

```
Write(".mpl/mpl/RUNBOOK.md"):
  # RUNBOOK — {user_request (first 100 chars)}
  Started: {ISO timestamp}

  ## Current Status
  - Phase: Step 0 Pre-flight complete
  - State: mpl-init
  - Last Updated: {ISO timestamp}

  ## Milestone Progress
  (interview pending)

  ## Key Decisions
  (none yet)

  ## Known Issues
  (none yet)

  ## Blockers
  (none)

  ## Discoveries
  (none yet)

  ## How to Resume
  Load: this file
  Next: Step 1 Interview Block → Step 2 Codebase → Stage 2 Ambiguity → Step 2.9 Baseline → Decomposition
```

### 0.3: 4-Tier Memory Load (F-25)

Load adaptive memory. Details in `mpl-run-phase0-memory.md`.

> **Status**: 4-tier structure is under review (see #55 follow-up). May collapse to 2-tier after measuring Tier-3/4 hit rate. Kept as-is in this refactor.

---

## Step 1: Interview Block (PP-derived, codebase-independent)

All four stages below depend only on `pivot-points.md` + accumulated user responses. **None of them consume codebase analysis** — they run before Step 2 so the interview is not biased by existing code.

### Stage 1: PP Discovery Interview (mpl-interviewer)

Single dispatch, always full depth (no light/full branching as of v0.17).

```
if .mpl/pivot-points.md exists:
  Load PPs and proceed to Stage 1.1

else:
  AskUserQuestion: "Define the project's core constraints (Pivot Points)?"
  Options:
    1. "Start interview"   → Run interviewer
    2. "Load existing PPs" → Read from user-provided path

Task(subagent_type="mpl-interviewer", model="opus", prompt=`
  user_request: ${user_request}
  provided_specs: ${provided_specs}
  mode: "full"  // always — light/full dual-track removed
`)
→ save .mpl/pivot-points.md + user_responses_summary
```

**Interview rounds** (Round 1-4, full):
1. Round 1: "What exactly do you want?" (PP candidates)
2. Round 2: "What must never be broken?" (PP constraints + scope boundaries)
3. Round 3: User segmentation + domain specifics
4. Round 4: Uncertainty calibration (merged from ex-Uncertainty Scan — no longer a separate high-density-only step)

PP states: **CONFIRMED** (hard constraint, auto-reject on conflict) / **PROVISIONAL** (soft, HITL on conflict).

### Stage 1.1: Core Scenarios (AD-0008)

Derive must-work user flows from confirmed PPs. Moved from ex-Step 3.5 in `phase0-analysis.md` — the derivation only needs PPs, so it belongs in the interview block.

**Runs only if** `.mpl/pivot-points.md` exists AND at least one PP has status CONFIRMED. Otherwise skip.

**Immutability (AD-0008 R-1)**: `.mpl/mpl/core-scenarios.yaml` is immutable after Phase 0 approval (Step 2.9 baseline snapshot). Only a full Phase 0 re-interview regenerates it. `mpl-sentinel-pp-file.mjs` extends to block post-approval writes.

```
confirmed_pps = Read(".mpl/pivot-points.md") → extract CONFIRMED entries
core_scenarios = []

for pp in confirmed_pps:
  AskUserQuestion(
    question: "PP-{pp.id} ({pp.title}) '동작한다'는 건 어떤 사용자 flow를 의미하나요?",
    header: "Core — PP-{pp.id}",
    options: [
      { label: "단일 core scenario", description: "하나의 flow로 PP 충족" },
      { label: "복수 core scenarios", description: "여러 분리된 flow로 나뉨" },
      { label: "PP는 invariant만, scenario 불필요", description: "테스트 대상 flow가 없는 개념적 PP" }
    ]
  )

  if answer == "PP는 invariant만":
    continue

  for scenario_idx in 1..answer_count:
    # Collect flow steps + acceptance via follow-up free-text
    core_scenarios.push({
      id: "CORE-{N}",
      pp_ref: pp.id,
      title: <user-provided>,
      user_story: <user-provided>,
      flow: [<steps>],
      must_work: true,
      acceptance: [<criteria>],
      source: "stage_1_1_hitl"
    })

Write(".mpl/mpl/core-scenarios.yaml", serialize({
  generated_at: now_iso(),
  generated_by: "stage_1_1",
  source_pps_hash: sha1(pivot-points.md),
  core_scenarios: core_scenarios
}))

Announce: "[MPL AD-0008] Core scenarios derived: {core_scenarios.length} scenarios from {confirmed_pps.length} PPs."
```

If zero scenarios (all PPs are invariants-only), still write `core_scenarios: []` — doctor audit `[h]` flags but does not FAIL (library-only projects).

### Stage 1.2: Intent Invariants (#50)

Teleological invariants that guard against subagent drift (MAST FM-1.1/2.2/2.3). Moved from ex-Step 3.6. Input: PPs + core_scenarios + user_request. All still interview-derived.

**Runs after** Stage 1.1 completes. Bugfix/trivial tasks may yield `invariants: []` — G2 invariant verification is a no-op when empty.

**Authoring (Option C — LLM draft + explicit confirm)**:

```
invariant_drafts = draft_invariants_from_context({
  user_request,
  pivot_points: confirmed_pps,
  core_scenarios,
  max_drafts: 3
})
# Each draft: { id: "INV-N", statement, verify, applies_to_phases }

confirmed_invariants = []
for draft in invariant_drafts:
  AskUserQuestion(
    question: "불변식 후보 {draft.id}: \"{draft.statement}\" — 검증: `{draft.verify}` — 적용 phase: {draft.applies_to_phases or '전체'}. 어떻게 처리할까요?",
    header: "INV-{N}",
    options: [
      { label: "Confirm (verbatim)", description: "문구와 verify 명령어를 그대로 채택" },
      { label: "Edit — 문구 수정",      description: "statement 또는 verify를 재입력" },
      { label: "Delete — 이 불변식 제외", description: "draft 폐기" }
    ]
  )
  if answer == "Confirm": confirmed_invariants.push(draft)
  elif answer == "Edit":  # Free-text re-entry
    confirmed_invariants.push({ id: draft.id, statement: <user>, verify: <user>, applies_to_phases: <user> })
  # Delete: nothing pushed
```

**Persistence**:

```yaml
# .mpl/mpl/phase0/design-intent.yaml
design_intent: {}   # per-phase design intent filled later
invariants:
  - id: INV-1
    statement: "..."
    verify: "..."
    applies_to_phases: [...]
```

Announce: `[MPL #50] Intent invariants: {confirmed_invariants.length} confirmed (from {invariant_drafts.length} drafts). Empty array → G2 invariant check is no-op.`

**Immutability**: `invariants` is unchangeable until Phase 0 re-interview. Decomposer/G2/Worker consume verbatim (no translation).

### Stage 1.3: User Contract Interview (0.16 Tier A')

Capture mutable user feature scope (UCs) into `.mpl/requirements/user-contract.md`, strictly separated from immutable PPs. Moved from ex-Step 1.5 — belongs in the interview block.

**Pattern**: Orchestrator-driven loop; no subagent dispatch. Calls `mpl_classify_feature_scope` MCP and interleaves `AskUserQuestion` between iterations. Max 4 iterations.

**Skip condition**: Legacy projects (pre-0.16) with no `.mpl/requirements/` directory — write graceful-skip `user-contract.md` with `user_cases: []` and spec-auto-extracted `scenarios`.

```
Read .mpl/pivot-points.md
Read spec/PRD text (from user or spec file)

iteration = 1
max_iterations = 4
accumulated_user_responses = ""
prev_contract = null  // set on iteration 2+ if prior user-contract.md exists

loop:
  result = mpl_classify_feature_scope({
    cwd,
    spec_text,
    pivot_points: <.mpl/pivot-points.md>,
    user_responses: accumulated_user_responses,
    prev_contract,
    round: iteration,
  })

  if result.convergence == true: break
  if result.next_question == null: break  # Treat as unrecoverable; write best-effort

  answer = AskUserQuestion({
    question: formatQuestion(result.next_question),
    header: shortHeaderFor(result.next_question.kind),
    options: optionsFrom(result.next_question.payload),
  })
  accumulated_user_responses += `\nround ${iteration}: Q: ${formatQuestion(result.next_question)} A: ${answer}`
  iteration += 1
  if iteration > max_iterations: break

Write .mpl/requirements/user-contract.md from result (YAML per docs/schemas/user-contract.md)

mpl_state_write({
  user_contract_set: true,
  user_contract_path: ".mpl/requirements/user-contract.md",
  user_contract_iterations: iteration,
})
Announce: `[MPL] Stage 1.3 complete. user_cases=${result.user_cases.length} deferred=${result.deferred.length} cut=${result.cut.length} scenarios=${result.scenarios.length} iterations=${iteration}.`
```

**Convergence Fallback**: if iteration == max_iterations and convergence == false, write `converged: false` in frontmatter + record unresolved as `ambiguity_hints[]` for Stage 2.

**Downstream Consumers**:

| Output | Consumer | Usage |
|---|---|---|
| `.mpl/requirements/user-contract.md` | Decomposer, Test Agent, Hooks | UC list + scenarios + skip_allowed |
| `user_contract_set` in state | `mpl-phase-controller` hook | Gate before decomposer dispatch |
| `scenarios[*]` | Decomposer Step 3-H, Test Agent | E2E scenario seeds |
| `ambiguity_hints[]` | Stage 2 Ambiguity Resolution | Targeted questions |

### Stage 1.9: Interview Snapshot Save (F-36)

Back up interview results to file before Step 2. Preserves key information across compaction events during Step 2/2.5.

```
Write(".mpl/mpl/interview-snapshot.md"):
  # Interview Snapshot
  Generated: {ISO timestamp}

  ## Pivot Points Summary
  {pivot-points.md CONFIRMED/PROVISIONAL list}

  ## Core Scenarios Summary
  {core-scenarios.yaml N CORE-N items one-line each}

  ## Intent Invariants Summary
  {design-intent.yaml invariants N INV-N items one-line each}

  ## User Contract Summary
  {user-contract.md UC count + key scenarios}

  ## User Request (Original)
  {user_request verbatim}

  ## Deferred Uncertainties
  {list if any, or "none"}
```

---

## Step 2: Codebase Analysis

> **Full protocol** is in `mpl-run-phase0-analysis.md`. Load that file when entering Step 2.

**Entry check** — Glob source files to decide whether to dispatch:

```
source_files = Glob("**/*.{ts,tsx,js,jsx,py,go,rs,java}")

if source_files.length == 0:
  # Greenfield — skip Step 2 entirely
  writeState(cwd, { codebase_skipped: true })
  Announce: "[MPL] Step 2 SKIP: greenfield (no source files). codebase_context will be null for Stage 2."
  → Proceed to Step 2.5

else:
  # Brownfield — dispatch codebase-analyzer
  Task(subagent_type="mpl-codebase-analyzer", model="haiku", prompt=<see phase0-analysis.md>)
  → Save .mpl/mpl/codebase-analysis.json
  writeState(cwd, { codebase_skipped: false })
```

---

## Step 2.5: Raw Scan

> **Full protocol** is in `mpl-run-phase0-analysis.md`. Load that file when entering Step 2.5.

**Scope (reduced per #56)**: Pure mechanical extraction only. Synthesis (complexity grade, type policy, error spec) moved to decomposer (#57).

Produces raw scan artifacts:
- Boundary pair scan (CB-01 — tauri-invoke / REST / JSON-RPC)
- API signatures (ast_grep + LSP fallback)
- Test pattern scan
- Type hints (Path A brownfield grep only)
- Error pattern locations

On greenfield (Step 2 skipped), still produces boundary pair **projections** from PP tech stack.

---

## Stage 2: Ambiguity Resolution Loop (post-codebase)

Orchestrator-driven loop using `mpl_score_ambiguity` MCP. Runs **after** Step 2 Codebase + Step 2.5 Raw Scan so `codebase_context` is actually populated.

**Input improvement vs v0.16**: the MCP now sees the full interview block output (PPs + core scenarios + invariants + user contract) plus codebase context. Scoring dimensions that need codebase (Spec Completeness / Technical Decision / Edge Case) are properly informed.

**Behavior (unchanged from #51)**:
- Unlimited retries — loop terminates on `threshold_met`, `ambiguity_override.active`, or user-halt/cancel.
- Stagnation detection (3 consecutive rounds, same weakest dimension, Δscore < 0.03) → user-facing choice (continue / halt with override / cancel). **Never** auto-terminates.
- PP conformance escalation — 3 consecutive rounds with `weakest_dimension == pp_conformance` → re-dispatch `mpl-interviewer` Stage 1 to repair PPs.
- Score is sacrosanct — `ambiguity_override.active` is the only bypass; score retains truthful value.

```
round = 0
while true:
  round += 1

  r = mpl_score_ambiguity({
    cwd,
    pivot_points,
    user_responses,    # accumulated Stage 1 + prior Stage 2 rounds
    core_scenarios,    # NEW in v0.17 (Stage 1.1 output)
    invariants,        # NEW in v0.17 (Stage 1.2 output)
    user_contract,     # NEW in v0.17 (Stage 1.3 output)
    spec_analysis,
    codebase_context,  # now populated from Step 2 (or null for greenfield)
    current_choices,
  })

  history = (readState(cwd).ambiguity_history ?? []).slice(-9)
  history.push({
    round, score: r.ambiguity_score,
    weakest_dimension: r.weakest_dimension_key,
    ts: new Date().toISOString()
  })
  mpl_state_write(cwd, {
    ambiguity_history: history,
    ambiguity_score: r.ambiguity_score,
  })

  if r.threshold_met: break

  recent = history.slice(-3)
  stagnating = recent.length == 3
               AND recent.every(h => h.weakest_dimension == recent[0].weakest_dimension)
               AND max(recent.map(h => h.score)) - min(recent.map(h => h.score)) < 0.03

  if stagnating:
    answer = AskUserQuestion({
      question: `Score plateaued around ${recent[0].score} for 3 rounds on ${r.weakest_dimension}. Continue, halt with override, or cancel?`,
      header: "Ambiguity score stagnating",
      options: [
        { label: "Continue",        description: "Ask another clarifying question (loop continues)." },
        { label: "Halt (override)", description: "Accept residual ambiguity. ambiguity_override is set; score stays truthful." },
        { label: "Cancel pipeline", description: "Stop. Start fresh via /mpl:mpl after refining the ask." }
      ]
    })
    if answer == "Halt (override)":
      reason = AskUserQuestion({ question: "Brief rationale for override (logged in metrics):" })
      mpl_state_write(cwd, {
        ambiguity_override: {
          active: true, reason: reason, by: "user_halt",
          set_at: new Date().toISOString()
        }
      })
      break
    if answer == "Cancel pipeline":
      mpl_state_write(cwd, { current_phase: "cancelled" })
      abort

  pp_stuck = recent.length == 3
             AND recent.every(h => h.weakest_dimension == "pp_conformance")
  if pp_stuck:
    Announce: "[MPL] pp_conformance weakest for 3 rounds — re-dispatching mpl-interviewer."
    Task(subagent_type="mpl-interviewer", model="opus", prompt=`
      user_request: ${user_request}
      provided_specs: ${provided_specs}
      prior_pivot_points: ${Read(".mpl/pivot-points.md")}
      pp_conformance_issues: ${JSON.stringify(r.dimensions.pp_conformance)}
      note: "Previous Stage 1 produced PPs that score poorly on pp_conformance.
             Refine or replace problematic PPs. Output a new pivot-points.md."
    `)
    # Stage 1 re-write landed. Continue Stage 2 loop with refreshed PPs.

  answer = AskUserQuestion({
    question: r.suggested_question,
    header: `Ambiguity resolution (round ${round}, weakest: ${r.weakest_dimension})`
  })
  user_responses += "\n[Round " + round + "] " + answer

# end while

# After Stage 2 completes, proceed to Step 2.9 baseline snapshot.
# Gate enforcement: mpl-ambiguity-gate.mjs allows decomposer dispatch when
# ambiguity_score <= 0.2 OR ambiguity_override.active.
```

**Re-entry**: when reached via `mpl-ambiguity-resolve` (router maps it here), this loop resumes. `ambiguity_history` persists across session boundaries, so stagnation detection is robust.

---

## Step 2.9: Branch Main State Snapshot (#59)

Immediately after Stage 2 closes (`threshold_met` OR `override`), record the immutable ground-truth snapshot that downstream delta calculation and rollback depend on.

### User Confirmation Gate

```
AskUserQuestion({
  question: "Phase 0 완료. 기능이 확정되었습니다. Baseline을 기록하고 decomposition으로 진행할까요?",
  header: "Phase 0 승인",
  options: [
    { label: "Approve & Snapshot", description: "baseline.yaml 기록 후 Decomposer 진입" },
    { label: "Modify PPs",         description: "Stage 1 재진입 (PP 수정)" },
    { label: "Re-interview",       description: "Stage 1 전체 재실행" }
  ]
})
```

If the answer is not "Approve", return to the chosen Stage. On "Approve", perform the snapshot below.

### Snapshot

Use `hooks/lib/mpl-baseline.mjs` helpers:

```
import { buildBaseline, writeBaseline, baselineExists } from "hooks/lib/mpl-baseline.mjs"

state = readState(cwd)
baseline = buildBaseline(cwd, {
  pipelineId: state.pipeline_id,
  userRequest: state.user_request,
  accumulatedResponses: state.stage2_accumulated_responses,
  ambiguity: {
    final_score: state.ambiguity_score,
    threshold_met: state.ambiguity_score !== null && state.ambiguity_score <= 0.2,
    override: state.ambiguity_override ?? null,
    rounds: (state.ambiguity_history ?? []).length,
  },
  codebaseSkipped: state.codebase_skipped ?? false,
})

// Re-interview path: if baseline already exists, drop the renewal flag
// so mpl-baseline-guard permits the overwrite, then delete it after write.
if baselineExists(cwd):
  Bash("touch .mpl/mpl/.baseline-renewal")
writeBaseline(cwd, baseline)
if existed:
  Bash("rm -f .mpl/mpl/.baseline-renewal")

mpl_state_write(cwd, {
  current_phase: "mpl-decompose",
  baseline_snapshot_at: new Date().toISOString(),
})
Announce: "[MPL #59] Step 2.9 baseline.yaml recorded. git_base_sha=${baseline.git.base_sha.slice(0,7)}, artifacts=${countNonNull(baseline.artifacts)}. Advancing to decomposition."
```

### Schema

```yaml
# .mpl/mpl/baseline.yaml (immutable after first write)
created_at: "ISO timestamp"
pipeline_id: "mpl-{feature}-{date}"
git:
  base_sha: "full SHA or null if not a git repo"
  base_branch: "branch name or null"
  working_tree_clean: boolean
artifacts:
  pivot_points:      { path, sha256 } | null
  core_scenarios:    { path, sha256 } | null
  design_intent:     { path, sha256 } | null
  user_contract:     { path, sha256 } | null
  codebase_analysis: { path, sha256, skipped: boolean }
  raw_scan:          { path, sha256 } | null
ambiguity:
  final_score: number | null
  threshold_met: boolean
  override: { active, reason, by } | null
  rounds: number
spec:
  user_request_hash:  "sha256 of user_request (normalized)"
  resolved_spec_hash: "sha256 of Stage 1 + Stage 2 accumulated responses (normalized)"
```

### Immutability (write-guard)

`hooks/mpl-baseline-guard.mjs` is a PreToolUse Edit|Write hook that:
1. Allows the first write (no `.mpl/mpl/baseline.yaml` yet).
2. Blocks subsequent writes **unless** `.mpl/mpl/.baseline-renewal` sentinel file exists.
3. Deny response explains the correct workflow: drop the sentinel, write, remove the sentinel.

The orchestrator uses this dance during Phase 0 re-interview to legitimately refresh the baseline. All other agents cannot overwrite baseline — prevents silent drift corruption.

### Consumers

| Consumer | Usage |
|---|---|
| Decomposer | Reads baseline for delta target (ground truth vs current state) |
| Seed Generator | Includes baseline hashes in seed for cache validation |
| 4.7 Partial Rollback | Uses `git.base_sha` as reset target on circuit break |
| 5.1.5 Scope Drift Detection | Compares current artifact hashes against baseline to detect unauthorized drift |
| Finalize 5.4 Metrics | Reports baseline-relative change volume |

### Branch Mode (optional)

`.mpl/config.json` may opt into worktree isolation:

```json
{ "branch_mode": "worktree" }
```

When set, Step 2.9 also runs `git worktree add` so the entire pipeline executes in an isolated directory. Default is `"snapshot"` — baseline records git SHA only, user manages branches.

Worktree mode integrates with existing 4.1.5 Worktree Isolation logic (`commands/mpl-run-execute-context.md`).

---

## Where to Go Next

| State after this file | Next action |
|---|---|
| `current_phase: mpl-decompose` | Load `mpl-run-decompose.md` |
| `current_phase: mpl-ambiguity-resolve` | Re-enter this file at Stage 2 (ambiguity loop) |
| `current_phase: cancelled` | Stop pipeline; user restarts via `/mpl:mpl` |

> **Note**: Step 2 (Codebase analysis) and Step 2.5 (Raw scan) detailed protocol lives in `mpl-run-phase0-analysis.md`. Load that file when entering those steps.
