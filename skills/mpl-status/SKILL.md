---
description: MPL pipeline status dashboard - phase progress, TODO completion, gate results, convergence metrics
---

# MPL Status

Display the current MPL pipeline status with structured metrics.

## Protocol

### Step 1: Read State

Read `.mpl/state.json` to get current pipeline state.
If no state file exists, report "MPL is not active."

### Step 2: Read decomposition.yaml

Read `.mpl/mpl/decomposition.yaml` to count phase progress:
- Each phase entry with status tracking
- Count completed vs total phases from decomposition

Also check `.mpl/state.json` for `phases_completed` count.

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
║  Gate 0.5 (Types):    {PASS|FAIL|PENDING|N/A}    ║
║  Gate 1   (Tests):    {PASS|FAIL|PENDING}         ║
║  Gate 1.5 (Coverage): {PASS|FAIL|PENDING|N/A}    ║
║  Gate 2   (Review):   {PASS|FAIL|PENDING}         ║
║  Gate 3   (PP+H):     {PASS|FAIL|PENDING|N/A}    ║
╠══════════════════════════════════════════════════╣
║  Research:                                       ║
║  Mode: {full|light|standalone|skipped}           ║
║  Stage: {stage1|stage2|stage3|completed|skipped} ║
║  Report: {path or "N/A"}                         ║
║  Findings: {count}  Sources: {count}             ║
╠══════════════════════════════════════════════════╣
║  Fix Loop: {count}/{max}                         ║
║  Convergence: {improving|stagnating|regressing}  ║
║  Pass Rate History: {rates}                      ║
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
| completed | "Pipeline complete. Run /mpl:mpl-compound to extract knowledge" |
| cancelled | "Pipeline was cancelled. Run /mpl:mpl-resume to continue" |

## Error States

- No `.mpl/` directory → "MPL has not been initialized. Say 'mpl' or run /mpl:mpl to start."
- Corrupted state.json → "State file is corrupted. Run /mpl:mpl-cancel --force to reset."
- Missing decomposition.yaml in phase execution → "decomposition.yaml not found. Return to Step 3 (Decompose)."
