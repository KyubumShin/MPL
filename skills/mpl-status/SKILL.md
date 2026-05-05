---
description: "MPL pipeline status dashboard — phase progress, TODO completion, gate results, convergence metrics. Use this skill when the user asks about pipeline progress or current state. Triggers on: '진행 상황', '어디까지 했어', 'status', 'mpl 상태', '몇 페이즈야', 'how far along', 'show progress', or any question about the current MPL pipeline execution state."
---

# MPL Status

Display the current MPL pipeline status with structured metrics.

## Protocol

### Step 1: Read State (3-source merge — G2 / #113)

Pre-G2 the dashboard read only `.mpl/state.json`. R-OBSERVABILITY-GAP
(Evidence A) showed each source carrying half the timeline by itself.
G2 makes the dashboard read all three and merge them:

| Source | What it carries | When it lands |
|---|---|---|
| `.mpl/state.json` | programmatic pipeline state (current_phase, gate_results, fix_loop_count, fix_loop_history, user_intervention_count, ...) | every `writeState` mutation |
| `.mpl/mpl/phases/phase-N/state-summary.md` | narrative finalize report per phase | phase-runner finalize |
| `.mpl/mpl/RUNBOOK.md` | timeline rows (phase, started_at, ended_at, gates, wall_min, fix_loops) | Stop hook on phase transition + PreCompact snapshot |

Procedure:

1. Read `.mpl/state.json`. If absent → report "MPL is not active." and stop.
2. Read all `.mpl/mpl/phases/phase-*/state-summary.md` files (best-effort; missing files are skipped, not errors).
3. Read `.mpl/mpl/RUNBOOK.md` table rows (best-effort; absent file = empty timeline).
4. Cross-reference: each completed phase from state.json should have BOTH a state-summary.md AND at least one RUNBOOK row. Report orphans (missing summary OR missing row) so the operator can spot observability holes during/after a run.

### Step 2: Read decomposition.yaml

Read `.mpl/mpl/decomposition.yaml` to count phase progress:
- Each phase entry with status tracking
- Count completed vs total phases from decomposition

Also read `.mpl/state.json.execution` (P2-6 — unified state) for authoritative progress: `execution.phases.completed` / `execution.phases.total` / `execution.phase_details[].status`.

### Step 3: Generate Dashboard

Output a structured dashboard:

```
╔══════════════════════════════════════════════════╗
║  MPL Pipeline Status                             ║
╠══════════════════════════════════════════════════╣
║  Pipeline ID : {pipeline_id}                     ║
║  Feature     : {extracted from pipeline_id}      ║
║  Started     : {started_at}                      ║
║  Duration    : {calculated}                      ║
╠══════════════════════════════════════════════════╣
║  Current Phase: {phase} {phase_icon}             ║
║                                                  ║
║  Phase Progress:                                 ║
║  [0]   Triage         {✅|⬜|🔄|⏭️}            ║
║  [1]   PP Interview   {✅|⬜|🔄|⏭️}            ║
║  [2]   Codebase Scan  {✅|⬜|🔄}                ║
║  [2.5] Phase 0 Enh.   {✅|⬜|🔄|⏭️}            ║
║  [3]   Decompose      {✅|⬜|🔄}                ║
║  [4]   Execute Loop   {✅|⬜|🔄}                ║
║  [5]   Finalize       {✅|⬜|🔄}                ║
╠══════════════════════════════════════════════════╣
║  TODO Progress: {completed}/{total} ({pct}%)     ║
║  ████████░░░░░░░░ {progress bar}                 ║
║  Completed: {N}  Pending: {N}  Failed: {N}       ║
╠══════════════════════════════════════════════════╣
║  Quality Gates:                                  ║
║  Hard 1 (Build+Type): {PASS|FAIL|PENDING}         ║
║  Hard 2 (Tests):      {PASS|FAIL|PENDING}         ║
║  Hard 3 (PP):         {PASS|FAIL|PENDING}         ║
║  Advisory (Contract): {PASS|WARN|N/A}             ║
╠══════════════════════════════════════════════════╣
║  Research:                                       ║
║  Mode: {full|light|standalone|skipped}           ║
║  Stage: {stage1|stage2|stage3|completed|skipped} ║
║  Report: {path or "N/A"}                         ║
║  Findings: {count}  Sources: {count}             ║
╠══════════════════════════════════════════════════╣
║  Fix Loop: {count}/{max}                         ║
║  Per-phase: {fix_loop_history summary}           ║
║  Convergence: {improving|stagnating|regressing}  ║
║  Pass Rate History: {rates}                      ║
╠══════════════════════════════════════════════════╣
║  User Interventions (auto-mode): {N}             ║
║  (every prompt during run_mode='auto' counts)    ║
╠══════════════════════════════════════════════════╣
║  Phase Timeline (RUNBOOK, newest first):         ║
║  {phase} {ended_at} gates={H1?H2?H3?} wall={N}m  ║
║  {phase} {ended_at} gates={H1?H2?H3?} wall={N}m  ║
║  ...up to last 10 rows...                        ║
║  Orphans: {N completed phases lack RUNBOOK row}  ║
║          {N completed phases lack state-summary} ║
╠══════════════════════════════════════════════════╣
║  Token Profile:                                  ║
║  Total Tokens: {total_tokens}                    ║
║  Avg/Phase:    {avg_tokens_per_phase}            ║
║  Duration:     {total_duration}s                 ║
║  Micro-fixes:  {total_micro_fixes}               ║
║  Retries:      {total_retries}                   ║
║  Anomalies:    {anomaly_count}                   ║
║  Cache:        {HIT|MISS}                        ║
╚══════════════════════════════════════════════════╝
```

### Step 3.5: G5 + G6 telemetry (#114) — surface fix_loop_history and user_intervention_count

- `state.fix_loop_history[]` — group by `phase`, sum `count` per group, render as `phase-1: 2, phase-3: 4` etc. Falls back to "(none)" when empty.
- `state.user_intervention_count` — render only when `state.run_mode === 'auto'`. In other run modes the field has no honest interpretation (every prompt is expected) and surfacing 0 would be misleading.

### Step 3.6: G2 timeline view (#113) — RUNBOOK rows + orphan detection

- Render the last 10 rows from RUNBOOK.md table newest-first. Each row: `{phase} | ended_at | gates | wall_min m | fix_loops` (per-phase, not sprint cumulative).
- Cross-reference with `state.execution.phase_details[]`. Treat as **terminal** (i.e. a row was expected) any phase whose status is in `{ 'completed', 'failed', 'circuit_break' }` (PR #134 nit #5):
  - Terminal phase whose id has NO matching RUNBOOK row → flag as orphan ("missing RUNBOOK row").
  - Terminal phase whose folder has NO `state-summary.md` → flag as orphan ("missing state-summary").
- Compaction-snapshot rows are recognizable by the `(compaction-N)` suffix in the phase column; render them with a distinct prefix (e.g. `…`) so the operator sees they're mid-phase markers, not finalized transitions. The `recordRunbookTransition` chain explicitly skips compaction-suffix rows when computing `started_at`, so the wall_min on each transition row reflects the full phase duration, not just the post-compaction segment (PR #134 review #1 fix).

### Step 4: Token Profile

Read `.mpl/mpl/profile/phases.jsonl` and `.mpl/mpl/profile/run-summary.json` to generate token usage metrics.

The profile library (`MPL/hooks/lib/mpl-profile.mjs`) provides:
- `analyzeProfile(cwd)` → `{ phases, totals, anomalies }`
- `readRunSummary(cwd)` → run summary object or null
- `formatReport(analysis, summary)` → formatted text report

Display in the Token Profile dashboard section:
- **Total Tokens**: sum across all phases
- **Avg/Phase**: average tokens per phase
- **Duration**: total execution time
- **Micro-fixes / Retries**: aggregate counts
- **Anomalies**: count of detected anomalies (token overuse >2x avg, excessive fixes ≥5, low pass rate <80%)
- **Cache**: Phase 0 cache hit/miss status from run-summary

If no profile data exists, show "No profile data available."

### Step 5: Phase-Specific Details

Based on the current phase, add contextual information:

- **phase1a-research**: Show research mode (full/light/standalone), current stage, stages completed, degraded stages if any
- **phase1b-plan**: Show research report path, key recommendation, agents launched for planning
- **phase1-plan** (legacy): List agents launched, waiting for outputs
- **phase2-sprint**: Show per-phase status from decomposition.yaml, worker assignments, blocked phases
- **phase3-gate**: Show each gate's detailed results
- **phase4-fix**: Show failure pattern, strategy being used, convergence trend
- **phase5-finalize**: Show learnings extracted, commits made

### Step 6: Recommendations

Based on state, suggest next action:

| State | Recommendation |
|-------|---------------|
| phase1a + not started | "Begin Phase 1-A: run Stage 1 Broad Scan" |
| phase1a + stage1 complete | "Run Stage 2 Deep-Dive on TOP findings" |
| phase1a + stage2 complete | "Run Stage 3 Synthesis to generate report" |
| phase1a + completed | "Research done. Proceed to Phase 1-B" |
| phase1b + no agents launched | "Run Phase 1-B planning agents with research input" |
| phase1b + agents complete | "Generate decomposition.yaml and get HITL approval" |
| phase1 + no agents launched | "Run Phase 1 exploration agents (legacy)" |
| phase1 + agents complete | "Generate decomposition.yaml and get HITL approval" |
| phase2 + blocked TODOs | "Complete dependency TODOs first: {list}" |
| phase3 + gate failed | "Enter Phase 4 fix loop or re-plan" |
| phase4 + stagnating | "Consider model escalation or re-plan" |
| phase5 | "Finalize: extract learnings and commit" |
| completed | "Pipeline complete. Learning extraction runs inline during finalize." |
| cancelled | "Pipeline was cancelled. Run /mpl:mpl-resume to continue" |

## Error States

- No `.mpl/` directory → "MPL has not been initialized. Say 'mpl' or run /mpl:mpl to start."
- Corrupted state.json → "State file is corrupted. Run /mpl:mpl-cancel --force to reset."
- Missing decomposition.yaml in phase execution → "decomposition.yaml not found. Return to Step 3 (Decompose)."
