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
       # 0.16 S3-3: attempt automated recovery before HITL fallback.
       # Collect the failure and defer handling until all required scenarios
       # have run — the diagnostician needs the full failure picture, not a
       # per-scenario slice.
       failures.append(s.id)
       continue

   # 0.16 S3-3: if any failure collected, go to Step 5.0.4 Automated Recovery.
   # That step either resolves all failures (loop back to "for s in required")
   # or halts the pipeline via circuit breaker → falls through to HITL.
   if failures:
     goto Step 5.0.4

3. Report:
   "[MPL AD-0008] E2E Scenarios: {passed}/{required.length} passed, {overridden} overridden, {failed_resolved_via_override} resolved via HITL override."

4. Legacy fallback (when AD-0008 source absent):
   Existing F-E2E-1 behaviour — S-items or default smoke, non-blocking logging.

Note: `hooks/mpl-require-e2e.mjs` enforces this at the Write/Edit level — any
attempt to write `finalize_done: true` to state.json while required scenarios
remain failing without override will be blocked.
```

- MED/LOW H-items are NOT re-asked here — they are aggregated in Step 5.1.8 (T-10, v3.9)

### 5.0.3: Playwright Trace Collection (0.16 S3-6)

When an E2E scenario fails, the diagnostician (Step 5.0.4) needs a trace
excerpt to classify accurately. This step wires up Playwright trace output
so the orchestrator can pass meaningful context to `mpl_diagnose_e2e_failure`.

**Auto-wrap policy** (applied inside Step 5.0 loop before `Bash(test_command)`):

```
if test_command matches /playwright/ AND test_command does not contain "--trace":
  # Inject trace flags — non-intrusive; Playwright writes zip files
  traceDir = ".mpl/e2e-traces"
  Bash("mkdir -p " + traceDir)
  wrapped = test_command + " --trace on --trace-dir " + traceDir + "/" + s.id
  Bash(wrapped, timeout=config.e2e_timeout or 60000)

elif test_command matches /pytest/ OR /jest/:
  # Other frameworks: no automatic trace injection. Diagnostician will
  # fall back to stderr_tail. Projects can configure project-level
  # trace via .mpl/config.json { "e2e_trace_cmd_prefix": "..." }.
  Bash(test_command)

else:
  Bash(test_command)
```

**Trace path recording** (post-execution, by orchestrator or gate-recorder):

```
# Look for the most recent trace zip under the expected directory
trace_path = ".mpl/e2e-traces/" + s.id + "/trace.zip"
if File.exists(trace_path):
  mpl_state_write({
    e2e_results: {
      [s.id]: { ...existing, trace_path }
    }
  })
```

**Storage contract**:

- Directory: `.mpl/e2e-traces/<scenario_id>/` (per scenario, isolated)
- `.gitignore` in user projects must exclude `.mpl/e2e-traces/` —
  `/mpl:mpl-doctor` warns when this line is missing and offers auto-patch.
- Trace files are MB-sized; only the `trace_path` string lives in state.json.
  The diagnostician reads up to 4KB from the trace file when building its
  `trace_excerpt` input (Step 5.0.4).

### 5.0.4: Automated E2E Recovery Loop (0.16 S3-3)

> **Full protocol** is in [`commands/references/e2e-recovery.md`](references/e2e-recovery.md).
> Load that file when `failures[]` is non-empty after Step 5.0.

**Trigger**: E2E failures from Step 5.0 (step 2) when `failures[]` is non-empty.
**Exit**: recovery succeeded → Step 5.1 · OR circuit breaker halts → HITL fallback.
**Classification** (3-way): A (append phases) | B (rerun phases) | C (manual intervention / HITL).

The recovery path replaces the pre-0.16 "fail → HITL 3 options" pattern. HITL still runs, but only after the automated diagnostician + circuit breaker path exhausts. Pre-check for Tier C UC coverage fails fast before any LLM call.

**Metrics**: `state.e2e_recovery.iter` counter + `.mpl/metrics/e2e-recovery.jsonl` per-iteration record (classification / confidence / iter), consumed by Stage 4 data-driven promotion analysis.

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

### 5.1.1: Artifact schema bulk re-check (P0-K / #115)

Defense-in-depth pass over every phase artifact. The PostToolUse hook
(`hooks/mpl-artifact-schema.mjs`) already validates each
write at the moment it lands; this step re-runs the same validator
across the whole workspace so a write that slipped through (e.g. a
manual orchestrator edit while the hook was disabled, or an artifact
that was valid at write time and later truncated) gets caught before
`finalize_done = true`.

```
Bash("node ${CLAUDE_PLUGIN_ROOT}/hooks/mpl-artifact-schema.mjs $(pwd)", timeout: 10_000)
```

The CLI exits non-zero when any artifact is invalid and emits a JSON
verdict (`{ totals: { files, valid, invalid }, results: [...] }`).

- Exit 0 → proceed to Step 5.1.5.
- Exit 1 → block finalize. Surface the missing-section list per file
  to the user and re-emit the offending artifacts before retrying.
  `enforcement.missing_artifact_schema = 'block'` will already have
  surfaced these earlier; this step is the operator's last sanity
  check.

The same CLI is consumed by mpl-doctor's Category 6 read-only audit.

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

### 5.1.6: Codex Audit (F6, #117) — Tier 4 last-mile sweep

Single dispatch of the codex auditor. Tier 1 (F2 hook scan), Tier 2 (F3
anti-pattern registry), and Tier 3 (F5 property check) catch ~7/8 of MPL
spec violations during execution. F6 is the finalize-time sweep that
catches the remaining 1/8 by cross-referencing intent (decomposition.yaml
+ user-contract.md) against implementation (declared impact files + git
diff).

Dispatch via Task to `mpl-codex-auditor`:

```
Task("mpl-codex-auditor", "Run finalize-time Tier 4 audit. Workspace: $(pwd). Plugin: ${CLAUDE_PLUGIN_ROOT}.")
```

The agent invokes:

```
Bash("node ${CLAUDE_PLUGIN_ROOT}/hooks/mpl-codex-audit.mjs $(pwd)", timeout: 30_000)
```

Audit envelope (`.mpl/mpl/audit-report.json`):

```json
{
  "schema_version": 1,
  "tier": 4,
  "verdict": "pass" | "fail",
  "summary": { "anti_pattern_residual": N, "missing_covers": N,
                "dangling_covers": N, "drift_undeclared": N,
                "drift_unimplemented": N },
  "surfaces": { ... },
  "inputs": { "decomposition_phases": N, "included_ucs": N }
}
```

Exit code policy (mirrors P0-2 enforcement):
- Exit 0 → `verdict: pass` OR (`verdict: fail` AND
  `enforcement.audit_residual !== 'block'`). Continue to Step 5.1.8 with
  findings surfaced as advisory.
- Exit 1 → `verdict: fail` AND `enforcement.audit_residual === 'block'`.
  Halt finalize. User must address residual anti-patterns and missing
  covers before re-running `/mpl-run-finalize`.
- Exit 2 → usage error (missing or invalid workspaceRoot). Treat as
  audit-skip with warning; continue.

Drift surface is INFORMATIONAL only and does not contribute to the FAIL
verdict — Step 5.1.5 already publishes drift to RUNBOOK; F6 collapses it
into the audit envelope so Post-Execution Review (5.1.8) and RUNBOOK
Finalize (5.6) can ingest a single Tier 4 artifact.

The orchestrator surfaces the agent's structured table (residual anti-
patterns, missing covers, dangling covers) to the user via systemMessage
and includes the verdict in the Completion Report (Step 5.5).

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

### AP-GATE-01 · "All green" from empty gate_results

When `state.gate_results.{hard1_baseline, hard2_coverage, hard3_resilience}`
contains a `null` entry or any `exit_code != 0`, yet the finalize report
declares "✅ clean" / "all green", the report is fabricated. Observed in
exp9/exp10/exp11: RUNBOOK said green while independent `pnpm lint` returned
exit 1 with 1, 17, and 53 errors respectively — a worsening trend that the
self-report concealed.

Root cause: machine evidence lives in `state.gate_results` (written by the
`mpl-gate-recorder` hook); RUNBOOK.md is the orchestrator's own narration of
the same session and therefore echoes its own claims. AD-0006 made
`state.json` the single source of truth for gate status precisely to break
this echo chamber. Warnings with `exit 1` are not clean, green icons in
stdout tails are UI rather than evidence, and `NOT EVALUATED` is information —
silently rendering it as whitespace turns an unmeasured gate into an apparent
PASS.

Build gate summaries only through `format_gate_summary(state.gate_results)`.
If any entry is `null` or non-zero exit, the corresponding status must render
as `NOT EVALUATED` or `PARTIAL (exit N)`, never `PASS` by absence. A
`three_gate_results.hardN_status: "PASS"` alongside
`state.gate_results.hardN_baseline.exit_code == 1` is self-contradictory and
blocks finalize.

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

Save to `.mpl/mpl/metrics.json`.

> See [`commands/schemas/metrics.json`](schemas/metrics.json) for the full schema with field comments.
>
> **Top-level shape**: phase/retry/discovery counters · `token_profile` (phase0/phases/phase5_gate/finalize/total_estimated) · `three_gate_results` (AD-0006 machine evidence derived from state.gate_results) · `intent_invariants` (#50 aggregation: total_declared/total_violations/discovery_from_intent_conflict/violated_ids/by_phase) · `verification_plan` (a/s/h counts) · `gap_analysis`, `tradeoff_analysis`, `side_interviews`, `convergence_triggers`.
>
> **v0.17 cleanup**: `phase0_grade` and `triage.interview_depth` fields removed (complexity grade and light/full dual-track deleted in #55/#56/#57).

**Intent Invariant aggregation rule (#50)**:
```
total_declared = sum over phases: count of unique invariant.id in phase.verification_plan.invariants
total_violations = sum over phases: phase.hard2_result.invariant_violation_count
discovery_from_intent_conflict = count of state.discoveries where type == "invariant_violation"
violated_ids = unique set of invariant.id values that had invariant_violation_count > 0 in any phase

# Graceful defaults when no invariants declared
if total_declared == 0:
  intent_invariants = { "total_declared": 0, "total_violations": 0, "discovery_from_intent_conflict": 0, "violated_ids": [], "by_phase": {} }
  # (no-op for bugfix/simple tasks — matches optional field semantics)
```

Generate full run profile at `.mpl/mpl/profile/run-summary.json`.

> See [`commands/schemas/run-summary.json`](schemas/run-summary.json) for the full schema.
>
> **Shape**: `run_id` · `complexity` (grade/score) · `cache` (phase0_hit/saved_tokens) · `phases[]` (per-phase tokens/duration_ms/pass_rate/micro_fixes) · `phase5_gate` · `totals`.

Profile data enables:
1. **Learn optimal token budget by complexity**: derive average tokens per grade from past profiles
2. **Optimize Phase 0 step combinations**: statistics on which step combinations are most efficient
3. **Detect abnormal runs**: warn on excessive token usage (2x+ the average), excessive micro-fixes (5+)

### 5.4.5: Manifest Generation — REMOVED (v0.17)

The pre-v0.17 manifest generation (F-FC-1, v0.8.5) wrote `.mpl/manifest.json`
for the Step 0.0.5 Artifact Freshness Check. Step 0.0.5 was deleted in v0.17
(#55) along with `field_classification` / `freshness_ratio` / `pp_proximity`
state fields, leaving manifest.json as a write-only orphan referencing
defunct Phase 0 Enhanced artifacts (`phase0/api-contracts.md` etc., collapsed
to a single `raw-scan.md` in #56). The whole step is removed; nothing now
reads or writes `.mpl/manifest.json`.

> If a future workflow needs artifact provenance, build it on top of
> `.mpl/mpl/baseline.yaml` (#59) — that file is already the v0.17 ground-truth
> snapshot for delta calculation and rollback.

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

> **Step 5.6.5 (F-22 Routing Pattern Recording) removed in v0.17 (#60)**:
> Write side deleted along with the read site (ex-Step 0.1.5a, removed in #55).
> Jaccard similarity matching on user_request strings was too noisy to drive
> tier recommendations reliably. `hooks/lib/mpl-routing-patterns.mjs` and
> `.mpl/memory/routing-patterns.jsonl` are no longer written or consumed.

### 5.7: Update State

Pipeline `current_phase = "completed"`, MPL `status = "completed"`, `completed_at = timestamp`.

---

> **Step 6 (Resume Protocol), F-33 Budget Pause Resume, Watcher-based Auto-Resume, Discovery Processing, and Related Skills have been moved to `mpl-run-finalize-resume.md`.**
> Load when resuming a session or processing discoveries.

---
