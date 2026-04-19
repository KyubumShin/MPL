---
description: MPL Finalize Protocol - E2E, Learnings, Commits, PR, Metrics
---

# MPL Finalize: Step 5 (E2E & Finalize)

This file contains Step 5 (E2E & Finalize) -- the main finalization protocol.
Load this when `current_phase` is `phase5-finalize` or when resuming a session.

> **See also:** `mpl-run-finalize-resume.md` (Resume Protocol, Budget Pause, Discovery Processing, Related Skills).

---

## Step 5: E2E & Finalize

### 5.0: E2E Test (Final) — AD-0008 Scenario Enforcement

After Gate System passes, run final E2E validation using a **3-tier source hierarchy** (AD-0008 supersedes F-E2E-1):

```
1. Collect E2E sources (priority order):
   a. AD-0008 scenarios: Read `.mpl/mpl/e2e-scenarios.yaml` (Decomposer output)
      — REQUIRED when Phase 0 produced core-scenarios.yaml
   b. Legacy S-items: `.mpl/mpl/verification-plan.md` domain:"e2e" entries
      — fallback for pre-v0.15.2 pipelines
   c. Default smoke: `state.e2e_command` or `npm test` / `cargo test` / `pytest`
      — minimum guarantee when neither (a) nor (b) present

   Resolution:
     if (a) exists AND has required scenarios → use (a), Step 5.0 PRIMARY
     elif (b) exists → use (b) (legacy mode)
     else → use (c) (bare-minimum smoke)

2. Primary execution (AD-0008 path):

   scenarios = Read(".mpl/mpl/e2e-scenarios.yaml").e2e_scenarios
   required = scenarios.filter(s => s.required != false)
   results = state.e2e_results or {}
   override = Read(".mpl/config/e2e-scenario-override.json") or {}

   for s in required:
     # Override (AD-0007/AD-0008 shape, either string or {reason,...} object)
     if override[s.id] or override["*"]:
       announce: "[MPL AD-0008] {s.id} skipped by override: {reason}"
       continue

     # Re-run if never executed or prior failure recorded
     existing = results[s.id]
     if not existing or existing.exit_code != 0:
       Bash(s.test_command, timeout=config.e2e_timeout or 60000)
       # mpl-gate-recorder.mjs writes state.e2e_results[s.id] from this execution

     final = state.e2e_results[s.id]
     if not final or final.exit_code != 0:
       # Still failing — HITL AskUserQuestion per AD-0008
       AskUserQuestion(
         question: "E2E {s.id} ({s.title}) 실패. 어떻게 처리할까요?",
         header: "E2E 실패 — {s.id}",
         options: [
           { label: "재시도",
             description: "스크립트 또는 환경 수정 후 같은 test_command로 재실행" },
           { label: "Override 추가",
             description: ".mpl/config/e2e-scenario-override.json에 사유와 함께 bypass 등록 (환경 이슈 등). 다음 런부터 자동 적용." },
           { label: "파이프라인 실패 처리",
             description: "finalize_done=false 유지. 사용자가 수동으로 scenario 수정 후 finalize 재시도." }
         ]
       )

       if choice == "재시도":
         Bash(s.test_command) again → re-check
       if choice == "Override 추가":
         # AD-0008 R-2: persist environment-level learning
         Read(".mpl/config/e2e-scenario-override.json") or {}
         Ask follow-up free-text: "override 사유 (20자 이상, 환경/시점 포함)"
         Write override with shape:
           {
             [s.id]: {
               reason: <user_input>,
               test_command_hash: sha1(s.test_command),
               recorded_at: now_iso(),
               source: "hitl_failure_resolution"
             }
           }
         announce: "[MPL AD-0008] Override added. Future runs auto-skip {s.id} unless test_command changes."
         continue to next scenario
       if choice == "파이프라인 실패":
         announce: "[MPL AD-0008] Finalize held. state.finalize_done remains false. Fix {s.id} then re-run /mpl:mpl-finalize."
         return from Step 5 WITHOUT setting finalize_done

3. Report:
   "[MPL AD-0008] E2E Scenarios: {passed}/{required.length} passed, {overridden} overridden, {failed_resolved_via_override} resolved via HITL override."

4. Legacy fallback (when AD-0008 source absent):
   Existing F-E2E-1 behaviour — S-items or default smoke, non-blocking logging.

Note: `hooks/mpl-require-e2e.mjs` enforces this at the Write/Edit level — any
attempt to write `finalize_done: true` to state.json while required scenarios
remain failing without override will be blocked.
```

- MED/LOW H-items are NOT re-asked here — they are aggregated in Step 5.1.8 (T-10, v3.9)

### 5.0.5: AD Final Verification

Before knowledge extraction, verify all AD (After Decision) markers:
- Check each AD has: interface definition + minimal implementation
- Incomplete ADs: report to user (awareness, not blocking)
- Report: `[MPL] AD Verification: {complete}/{total} ADs verified.`

### 5.1: Final Verification

Run ALL success_criteria from ALL completed phases. If project has build/test commands:
```
Bash("npm run build")
Bash("npm test")
```

### 5.1.5: Scope Drift Report (V-05, v0.8.0)

Compare declared scope vs actual changes to detect implementation drift:

```
// Collect declared files from decomposition.yaml
declared_files = []
for each phase in decomposition.phases:
  for each file in phase.impact.create:
    declared_files.push(file.path)
  for each file in phase.impact.modify:
    declared_files.push(file.path)
declared_files = unique(declared_files)

// Collect actual changed files from git
commit_count = mpl_state.phases.completed  // approximate
actual_result = Bash("git diff --name-only HEAD~{commit_count} 2>/dev/null || git diff --name-only --cached")
actual_files = parse_lines(actual_result.stdout)

// Calculate drift
added_files = actual_files.filter(f => !declared_files.includes(f))     // changed but not declared
missed_files = declared_files.filter(f => !actual_files.includes(f))    // declared but not changed
drift_ratio = added_files.length / Math.max(declared_files.length, 1)

// Report in RUNBOOK (informational only — does NOT block)
append to RUNBOOK.md:
  ## Scope Drift Report (V-05)
  - Declared files: {declared_files.length}
  - Actual files: {actual_files.length}
  - Undeclared changes: {added_files.length} ({(drift_ratio * 100).toFixed(0)}% drift)
  - Unimplemented declared: {missed_files.length}
  - Undeclared files: {added_files.join(", ") || "none"}
  - Missing files: {missed_files.join(", ") || "none"}

announce: "[MPL] Scope Drift: {(drift_ratio * 100).toFixed(0)}% ({added_files.length} undeclared, {missed_files.length} unimplemented)"
// No blocking — data collection for future Gate integration
```

### 5.1.8: Post-Execution Review Report (T-10, v3.9)

> **Note**: This step was previously numbered 5.5. Renumbered to 5.1.8 in v0.8.3 to fix ordering
> (must run after verification but before learning extraction).

Aggregate all deferred items accumulated during execution into a structured review report.
This step is **informational only** — it does NOT block pipeline completion.

```
sources = []

# 1. MED/LOW H-items deferred from Gate 3
if exists(".mpl/mpl/deferred-review.md"):
  sources += parse(".mpl/mpl/deferred-review.md")

# 2. Per-phase deferred items (non-critical discoveries, AD markers)
for each completed phase:
  path = ".mpl/mpl/phases/{phase.id}/deferred-items.md"
  if exists(path):
    sources += parse(path)

# 3. Gate 2 auto-resolved NEEDS_FIXES (if any were auto-fixed)
# (tracked in RUNBOOK quality results section)

  # 4. Hard 3 contract violations (if any were deferred)
  if exists(".mpl/mpl/hard3-violations.md"):
    hard3_warnings = parse(".mpl/mpl/hard3-violations.md")
    for each w in hard3_warnings:
      sources += { severity: "MED", item: w.description, phase: "Hard 3", reason: "contract diff advisory" }

if sources is empty:
  announce: "[MPL] Post-Execution Review: No deferred items. Clean execution."
else:
  # Categorize into 3 sections:
  worth_reviewing = [s for s in sources if s.severity == "MED"]
  improvement_directions = [s for s in sources if s.severity == "LOW"]
  auto_resolved = [s for s in sources if s.type == "auto-resolved"]

  announce: """
  [MPL] === Post-Execution Review ===

  ## Worth Reviewing ({count} items)
  Items where human judgment may add value:
  {for each: - [{severity}] {item} (Phase {phase}) — {reason}}

  ## Improvement Directions ({count} items)
  Patterns to consider for next iteration:
  {for each: - {item} — {suggestion}}

  ## Auto-Resolved Summary ({count} items)
  Decisions made autonomously during execution (for transparency):
  {for each: - {item} — resolved as: {resolution}}

  Review at your discretion. None of these blocked execution.
  """

  # LT-05 (v0.8.6): H-Item Severity Feedback Loop
  # Track if user reclassifies severity during review (e.g., "this MED should have been HIGH")
  # If user provides severity corrections, update h_item_metrics in state.json:
  h_item_metrics = readState(cwd).h_item_metrics
  h_item_metrics.h_item_total = count(all H-items from verification-plan.md)
  h_item_metrics.h_item_side_interviews = count(HIGH H-items that triggered AskUserQuestion)
  h_item_metrics.h_item_review_rate = count(items user explicitly reviewed) / max(total_deferred, 1)

  # If user says "this should be HIGH" for a MED item:
  #   h_item_metrics.severity_overrides.med_to_high += 1
  # If user says "this is not important" for a HIGH item:
  #   h_item_metrics.severity_overrides.high_to_low += 1

  writeState(cwd, { h_item_metrics })
  announce: "[MPL] H-Item metrics: {h_item_total} total, {h_item_side_interviews} interviews, {severity_overrides} reclassifications."
```

### 5.2: Extract Learnings

Extract learnings directly from the MPL session:
```
Analyze:
  - Phase summaries: {all state-summary.md contents}
  - Phase decisions: {all PDs}
  - Discoveries: {all discoveries}
```
Save to `docs/learnings/{feature}/`: learnings.md, decisions.md, issues.md, metrics.md

### 5.2.5: Run-to-Run Learning Distillation (F-11)

Distill RUNBOOK decisions/issues into persistent learnings for future runs:

```
runbook = Read(".mpl/mpl/RUNBOOK.md")
existing_learnings = Read(".mpl/memory/learnings.md") or ""

Distill execution learnings into the persistent memory file:

     ## Input
     - RUNBOOK (current run): {runbook}
     - Phase Summaries: {all state-summary.md contents}
     - Existing Learnings (append, do not duplicate): {existing_learnings}

     ## Output Format
     Append NEW entries only to the existing file. Use this structure:

     ### Failure Patterns
     - [{date}] {pattern description} — {resolution}

     ### Success Patterns
     - [{date}] {what worked and why}

     ### Project Conventions (discovered)
     - {convention discovered during execution}

     Rules:
     1. Do NOT duplicate entries already in existing learnings
     2. Only record patterns that would help FUTURE runs
     3. Skip session-specific details (file paths, variable names)
     4. Focus on generalizable lessons (type mismatches, API patterns, test strategies)

Save output to `.mpl/memory/learnings.md`
Ensure .mpl/memory/ directory exists.
Report: "[MPL] Learnings distilled: {new_entries} new patterns added to memory."
```

### 5.2.6: 4-Tier Memory Update (F-25)

Execute 4-Tier Memory protocol:

1. **Update episodic.md**: Append summary of each completed Phase to episodic.md
   - Format: `### Phase {N}: {name} ({timestamp})\n{2-3 line summary: what was implemented, key decisions, results}`
   - Also include Phase 0 summary (complexity grade, applied steps, etc.)

2. **Episodic compression**: Run time-based compression
   - Recent 2 Phases: keep detailed (2-3 lines)
   - Earlier Phases: compress to 1 line (`- Phase N: {name} — {result}`)
   - Maintain 100-line cap

3. **Promote to semantic.md**: Detect patterns repeated 3+ times in episodic → generalize
   - Repeated failure patterns → formalize as rules in "## Failure Patterns" section
   - Repeated success patterns → formalize in "## Success Patterns" section
   - Repeated conventions → formalize in "## Project Conventions" section
   - Corresponding entries in episodic are compressed to 1 line + semantic reference link

4. **Clean up procedural.jsonl**: Save tool patterns extracted during learning distillation
   - Classification tags: type_mismatch, dependency_conflict, test_flake, api_contract_violation, etc.
   - If exceeding 100 entries, delete oldest entries first (FIFO)

4a. **Harvest Fix Loop reflection tags (AD-03, v0.13.0)**:
    Glob Fix Loop reflection files and extract their structured pattern tags
    into `procedural.jsonl`. These tags are already enum-typed (F-27 §4.6.1
    template) — no LLM parsing needed, mechanical extraction only.

    ```
    reflection_files = Glob(".mpl/mpl/phases/*/reflections/attempt-*.md")

    for each file in reflection_files:
      content = Read(file)
      // Extract the "Pattern classification tag: {tag}" line from §4 Learning
      tag_match = content.match(/Pattern classification tag:\s*(\w+)/)
      if not tag_match: continue

      tag = tag_match[1]
      // Extract phase_id and attempt_id from path
      // Pattern: .mpl/mpl/phases/{phase_id}/reflections/attempt-{N}.md
      phase_id = extract_phase_id(file.path)
      attempt_id = extract_attempt_id(file.path)

      // Dedupe: skip if this exact entry already exists (idempotent across re-runs)
      existing = Read(".mpl/memory/procedural.jsonl") or ""
      dedup_key = phase_id + ":" + attempt_id + ":" + tag
      if dedup_key in existing: continue

      // Extract root cause summary (§2 Root Cause, first line only)
      root_cause_match = content.match(/### 2\. Root Cause\n(.+)/)
      root_cause = root_cause_match ? root_cause_match[1].trim() : ""

      // Append to procedural.jsonl
      entry = {
        "source": "fix_loop_reflection",
        "tag": tag,
        "phase_id": phase_id,
        "attempt": attempt_id,
        "root_cause": root_cause,
        "file": file.path,
        "pipeline_id": state.pipeline_id,
        "timestamp": now_iso()
      }
      Bash("echo '" + JSON.stringify(entry) + "' >> .mpl/memory/procedural.jsonl")

    harvested_count = count of entries appended
    announce: "[MPL] AD-03: {harvested_count} Fix Loop reflection tags harvested to procedural.jsonl"
    ```

    Consumer: next run's Phase 0 memory load via 4-tier routing (F-25) — the
    `procedural.jsonl` entries surface as "known failure patterns for this
    project" during Seed generation, preventing repeat mistakes.

5. **Update state.json memory field**: Update memory statistics

```
Execute 4-Tier Memory protocol (F-25) directly:
  - Phase summaries: {all state-summary.md contents}
  - RUNBOOK: {runbook contents}
  - Follow Steps M-1 through M-5.

Report: "[MPL] 4-Tier Memory updated: episodic={N} entries, semantic={N} rules, procedural={N} entries."
```

### 5.2.65: Phase Hint Extraction (BM-02, v0.8.6)

Extract one-line phase lessons from the completed pipeline for future decomposition guidance:

```
Review the completed pipeline and extract 1-3 Phase Hints — one-line constraints
that should guide FUTURE decomposition. Focus on lessons about phase ordering,
separation of concerns, and dependency management.

Input:
  - Phase Summaries: {all state-summary.md contents}
  - Phase Decisions: {all PDs}
  - Discoveries: {all discoveries}

Output Format:
  Return a JSON array of hint strings. Examples:
  - "DB migration: always separate schema changes and data migration into distinct phases"
  - "API endpoint: define types in a dedicated phase before implementation phases to reduce downstream errors"
  - "Auth middleware: place cross-cutting concerns in early phases as other phases depend on them"

Rules:
  1. Only output hints from actual lessons learned in THIS pipeline
  2. Each hint must be a single actionable sentence
  3. No generic advice — be specific to the patterns observed
  4. Skip if pipeline was straightforward with no notable phase-ordering lessons

// Save each hint via addPhaseHint() to semantic.md
for each hint in output:
  addPhaseHint(cwd, hint)

Report: "[MPL] Phase hints: {count} lessons extracted to semantic memory."
```

### 5.2.7: Clear working.md

Clear working.md on pipeline completion (for next run).

```
clearWorkingMemory(cwd)
Report: "[MPL] Working memory cleared."
```

### Step 5.2.8: Good/Bad Examples Archive Classification (F-26)

On pipeline completion, evaluate the effectiveness of requirements documents generated by mpl-interviewer v2 and archive them.

#### Classification Criteria

| Metric | Good Example | Bad Example |
|--------|-------------|------------|
| Phase 0 retry count | 0-1 | 3+ |
| Circuit break count | 0 | 1+ |
| Gate pass rate | 95%+ (1st attempt) | 2+ attempts |
| User correction requests | 0 | 2+ |

#### Protocol

```pseudocode
if exists(".mpl/pm/requirements-*.md"):
  metrics = {
    phase0_iterations: state.phase0_retry_count or 0,
    circuit_break_count: state.phases.circuit_breaks or 0,
    gate_attempts: count_gate_retries(state),
    user_corrections: count_side_interview_corrections(state)
  }

  score = (metrics.phase0_iterations <= 1) + (metrics.circuit_break_count == 0) + (metrics.gate_attempts <= 1) + (metrics.user_corrections == 0)

  if score >= 3:
    copy requirements to ".mpl/pm/good-examples/{date}-{topic}.md"
  elif score <= 1:
    copy requirements to ".mpl/pm/bad-examples/{date}-{topic}.md"
  # score 2: middle — do not archive
```

Orchestrator performs this directly in Step 5 Finalize (no separate agent needed).

**F-25 Memory Integration:**
After archive classification, record quality signals in procedural.jsonl:
- Good → `appendProcedural(cwd, { tool: "mpl-interviewer", result: "success", tags: ["prd_quality_good", depth], context: filename })`
- Bad → `appendProcedural(cwd, { tool: "mpl-interviewer", result: "failure", tags: ["prd_quality_bad", depth, reason], context: filename })`
This allows the interviewer in future runs to reference past PRD quality patterns.

### 5.3: Atomic Commits

Reuse `mpl-git-master`:
```
Task(subagent_type="mpl-git-master", model="sonnet",
     prompt="Create atomic commits for all changes. Detect project commit style. 3+ files -> 2+ commits.")
```

### 5.3b: PR Creation (T-04, v4.0)

Optional — activated when `.mpl/config.json` → `auto_pr.enabled: true` OR
user's original prompt contains "PR", "pull request", or "ship".

```
if config.auto_pr?.enabled or task_prompt_mentions_pr:
  // Gather PR context — AD-0006: state.json SSOT only, no RUNBOOK parsing.
  // gate-recorder hook populates state.gate_results[hard1_baseline/hard2_coverage/hard3_resilience]
  // with {command, exit_code, stdout_tail, timestamp}. Orchestrator self-report ("all green")
  // is NOT evidence — only exit_code == 0 counts as PASS.
  state = readState(cwd)
  gate_results = format_gate_summary(state.gate_results)
  deferred = Read(".mpl/mpl/deferred-review.md") or "None"
  pp_summary = Read(".mpl/pivot-points.md") → first 3 PPs

  Task(subagent_type="mpl-git-master", model="sonnet",
    prompt="Create a pull request for the completed MPL pipeline.
    pr_creation: true
    Base branch: auto-detect
    Title: derive from task description
    PR Body context:
    ## PP Summary
    {pp_summary}
    ## Quality Gate Results
    {gate_results}
    ## Deferred Review Items
    {deferred}")

  if pr_url:
    announce: "[MPL] PR created: {pr_url}"
    append to RUNBOOK: "## PR Created\n- URL: {pr_url}\n- Timestamp: {ISO}"
  else:
    announce: "[MPL] PR creation skipped or failed. See git-master output for details."
else:
  announce: "[MPL] Step 5.3b: PR creation skipped (not enabled in config or prompt)"
```

### Common Rationalizations (AD-0006, #38/#39 Gate 집계)

exp9 (4.6), exp10 (4.6), exp11 (4.7) 모두에서 orchestrator가 `gate_results: null`인 상태로 "✅ all green"을 발행했다. 독립 `pnpm lint` 실측은 각각 exit 1 (1→17→53 errors, 악화 추세). 다음 합리화는 **모두 잘못**이다.

| Rationalization | Why it's wrong |
|---|---|
| "phase-runner가 'all tests passed'라고 보고했으니 Hard 2 ✅" | self-report는 **증거가 아니다**. exit code가 `state.gate_results.hard2_coverage.exit_code`에 기록되지 않았다면 pass 여부를 모른다. RUNBOOK.md의 자연어 서술도 증거 아님. |
| "RUNBOOK에 적힌 gate 결과를 취합하면 됨" | RUNBOOK은 orchestrator의 **자가 서술**. 동일 세션이 쓴 문서를 취합하는 것은 echo chamber. AD-0006은 `state.json.gate_results` machine evidence만 인정하도록 명시. |
| "warning은 있지만 error 없으니 clean" | exit 1 + warnings는 **NOT clean**. exp9에서 "26 warnings만 있고 pass"라고 주장했으나 실제로는 `exit 1` — "warning ok" 합리화가 정확히 실패한 지점. |
| "Phase-runner 결과의 stdout 꼬리가 녹색이면 PASS로 판정 가능" | stdout 색/아이콘은 UI 요소일 뿐. `{exit_code: 0}`만이 PASS 증거. |
| "format_gate_summary가 NOT EVALUATED를 뱉으면 그냥 공란으로 두자" | NOT EVALUATED를 공란 처리하면 **미검증 gate가 PASS로 보이게 된다** — 정확히 이 세 실험에서 발생한 거짓 보고 패턴. NOT EVALUATED는 반드시 표기. |

### Red Flags — 즉시 정지

- Finalize 보고서에 "✅ clean" / "all green"을 쓰려고 하는데 `state.gate_results.{hard1_baseline, hard2_coverage, hard3_resilience}` 중 하나라도 `null`이거나 `exit_code != 0`이면 → **정지**. "PARTIAL" 또는 "NOT EVALUATED"로 다시 쓰라.
- PR 본문의 Quality Gate Results 섹션에 `format_gate_summary()` 출력 대신 직접 작성한 문구를 넣으려 한다면 → **정지**. SSOT 위반.
- `state.gate_results.hard1_baseline.exit_code == 1` 인데 `three_gate_results.hard1_status: "PASS"`를 기록하려 한다면 → **fatal inconsistency**. 자기 모순이다.

**`format_gate_summary(gate_results)` contract (AD-0006)** — builds a Markdown table
purely from `state.json.gate_results` without parsing RUNBOOK.md. This is the single
canonical path for gate status in finalize output.

```
function format_gate_summary(gr):
  gates = [
    ["Hard 1 Baseline", gr.hard1_baseline],
    ["Hard 2 Coverage", gr.hard2_coverage],
    ["Hard 3 Resilience", gr.hard3_resilience],
  ]
  lines = ["| Gate | Status | Command | Exit | Evidence |",
           "|---|---|---|---|---|"]
  for name, entry in gates:
    if entry is null:
      status = "NOT EVALUATED"
      cmd = exit = tail = "—"
    elif entry.exit_code == 0:
      status = "PASS"
      cmd = entry.command
      exit = 0
      tail = entry.stdout_tail[0:60] + "…"
    else:
      status = f"PARTIAL (exit {entry.exit_code})"
      cmd = entry.command
      exit = entry.exit_code
      tail = entry.stdout_tail[0:60] + "…"
    lines.append(f"| {name} | {status} | `{cmd}` | {exit} | `{tail}` |")
  return "\n".join(lines)
```

**Rules enforced by this function (AD-0006)**:
- "✅ clean" / "all green" strings are **forbidden** when any `entry.exit_code != 0`.
- `null` entry → "NOT EVALUATED" (never "PASS" by absence).
- The `three_gate_results` metrics block at Step 5.4 is also derived from
  `state.gate_results`, not from RUNBOOK parsing.

Config example (`.mpl/config.json`):
```json
{
  "auto_pr": {
    "enabled": false,
    "base_branch": "auto"
  }
}
```

### 5.4: Metrics

Save to `.mpl/mpl/metrics.json`:
```json
{
  "phases_completed": 4, "phases_failed": 0,
  "total_retries": 2, "total_micro_fixes": 3,
  "total_discoveries": 3, "total_pd_count": 8, "total_pd_overrides": 1,
  "final_pass_rate": 100, "phase5_skipped": true,
  "phase0_cache_hit": false,
  "phase0_grade": "Complex",
  "phase0_artifacts_validated": "3/3",
  "token_profile": {
    "phase0": 12000,
    "phases": [10000, 12000, 8000, 5000],
    "phase5_gate": 500,
    "finalize": 2000,
    "total_estimated": 49500
  },
  "elapsed_ms": 720000, "final_verification": "all_pass",
  "side_interviews": { "count": 0, "phases": [] },
  "convergence_triggers": { "stagnation": 0, "regression": 0 },
  "gap_analysis": { "missing_requirements": 0, "pitfalls": 0, "constraints": 0 },
  "tradeoff_analysis": { "aggregate_risk": "LOW", "irreversible_count": 0 },
  "critic_assessment": "READY",
  "three_gate_results": {
    // AD-0006: derived from state.gate_results (machine evidence, not self-report).
    // hard{1,2,3}_status ∈ { "PASS" (exit 0), "PARTIAL" (exit != 0), "NOT_EVALUATED" (null) }
    "hard1_status": "PASS", "hard1_exit_code": 0, "hard1_command": "pnpm lint && pnpm build",
    "hard2_status": "PASS", "hard2_exit_code": 0, "hard2_command": "pnpm test --run",
    "hard3_status": "NOT_EVALUATED", "hard3_exit_code": null, "hard3_command": null
  },
  "verification_plan": { "a_items": 0, "s_items": 0, "h_items": 0 },
  "triage": { "interview_depth": "full", "prompt_density": 3 }
}
```

Generate full run profile at `.mpl/mpl/profile/run-summary.json`:
```json
{
  "run_id": "mpl-{timestamp}",
  "complexity": { "grade": "Complex", "score": 85 },
  "cache": { "phase0_hit": false, "saved_tokens": 0 },
  "phases": [
    { "id": "phase0", "tokens": 12000, "duration_ms": 15000, "cache_hit": false },
    { "id": "phase-1", "tokens": 10000, "duration_ms": 45000, "pass_rate": 100, "micro_fixes": 0 },
    { "id": "phase-2", "tokens": 12000, "duration_ms": 60000, "pass_rate": 100, "micro_fixes": 1 },
    { "id": "phase-3", "tokens": 8000, "duration_ms": 40000, "pass_rate": 100, "micro_fixes": 0 },
    { "id": "phase-4", "tokens": 5000, "duration_ms": 30000, "pass_rate": 100, "micro_fixes": 0 }
  ],
  "phase5_gate": { "final_pass_rate": 100, "decision": "skip", "fix_tokens": 0 },
  "totals": { "tokens": 49500, "duration_ms": 210000, "micro_fixes": 1, "retries": 0 }
}
```

Profile data enables:
1. **Learn optimal token budget by complexity**: derive average tokens per grade from past profiles
2. **Optimize Phase 0 step combinations**: statistics on which step combinations are most efficient
3. **Detect abnormal runs**: warn on excessive token usage (2x+ the average), excessive micro-fixes (5+)

### 5.4.5: Manifest Generation (F-FC-1, v0.8.5)

Generate `.mpl/manifest.json` to track all `.mpl/` artifacts for freshness checking in future runs.
This file is consumed by Step 0.0.5 (Artifact Freshness Check) in the next MPL execution.

**NOTE**: This is separate from `.mpl/cache/phase0/manifest.json` (Phase 0 cache-specific).

```pseudocode
commit_hash = Bash("git rev-parse HEAD").trim()

tracked_artifacts = []

// 1. Phase 0 Enhanced artifacts
phase0_files = ["phase0/api-contracts.md", "phase0/examples.md",
                "phase0/type-policy.md", "phase0/error-spec.md",
                "phase0/summary.md", "phase0/complexity-report.json"]
for each file in phase0_files:
  path = ".mpl/mpl/" + file
  if file_exists(path):
    hash = Bash("shasum -a 256 {path}").split(" ")[0]
    tracked_artifacts.push({ path, hash, timestamp: file_mtime(path), source: "mpl", category: "phase0" })

// 2. Core artifacts
core_files = [
  { path: ".mpl/mpl/decomposition.yaml", category: "decomposition" },
  { path: ".mpl/pivot-points.md", category: "interview" },
  { path: ".mpl/mpl/phase-decisions.md", category: "decisions" },
  { path: ".mpl/mpl/RUNBOOK.md", category: "runbook" },
  { path: ".mpl/mpl/codebase-analysis.json", category: "analysis" },
  { path: ".mpl/mpl/interview-snapshot.md", category: "interview" },
  { path: ".mpl/mpl/verification-plan.md", category: "verification" }
]
for each entry in core_files:
  if file_exists(entry.path):
    hash = Bash("shasum -a 256 {entry.path}").split(" ")[0]
    tracked_artifacts.push({ path: entry.path, hash, timestamp: file_mtime(entry.path), source: "mpl", category: entry.category })

// 3. Write manifest (memory files excluded — append-only files cause false staleness)
manifest = {
  version: "0.9.2",
  generated_at: new Date().toISOString(),
  commit_hash: commit_hash,
  pp_proximity: state.pp_proximity,
  field_classification: state.field_classification || "field-1",
  artifact_count: tracked_artifacts.length,
  artifacts: tracked_artifacts
}

Write(".mpl/manifest.json", JSON.stringify(manifest, null, 2))
Announce: "[MPL] Manifest generated: {tracked_artifacts.length} artifacts tracked at commit {commit_hash.slice(0,7)}."
```

### 5.5: Completion Report

> **Note**: Previously duplicated as 5.5. Now unique after Post-Execution Review was renumbered to 5.1.8.

Summarize: phases completed/failed, retries, circuit breaks, key discoveries/PD overrides, verification status, key learnings.

### 5.6: RUNBOOK Finalize (F-10)

Append final section to `.mpl/mpl/RUNBOOK.md`:
```markdown
## Pipeline Complete
- **Status**: {completed | partial}
- **Phases**: {completed}/{total}
- **Final Pass Rate**: {pass_rate}%
- **Total Retries**: {total_retries}
- **Total Micro-fixes**: {total_micro_fixes}
- **Circuit Breaks**: {circuit_break_count}
- **Elapsed**: {elapsed_ms}ms
- **PP-Proximity**: {pp_proximity}
- **Escalations**: {escalation_count}
- **Completed At**: {ISO timestamp}
```

### 5.6.5: Routing Pattern Recording (F-22)

Record execution result to `.mpl/memory/routing-patterns.jsonl` for future tier prediction:

```
state = Read(".mpl/state.json")
mpl_state = Read(".mpl/mpl/state.json")

pattern = {
  description: state.task or user_request (first 100 chars, summarized),
  proximity: state.pp_proximity,
  escalated_from: state.escalation_history.length > 0
    ? state.escalation_history[0].from
    : null,
  result: mpl_state.status,  // "completed" | "partial" | "failed"
  tokens: mpl_state.totals.total_tokens or profile.totals.tokens,
  files: count of all created/modified files across phases
}

appendPattern(cwd, pattern)
// Uses hooks/lib/mpl-routing-patterns.mjs

Report: "[MPL] Routing pattern recorded: proximity={proximity}, result={result}, tokens={tokens}."
```

### 5.7: Update State

Pipeline `current_phase = "completed"`, MPL `status = "completed"`, `completed_at = timestamp`.

---

> **Step 6 (Resume Protocol), F-33 Budget Pause Resume, Watcher-based Auto-Resume, Discovery Processing, and Related Skills have been moved to `mpl-run-finalize-resume.md`.**
> Load when resuming a session or processing discoveries.

---
