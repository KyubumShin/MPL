---
description: MPL (Micro-Phase Loop) full orchestration protocol
---

# MPL Orchestration Protocol

You are now operating as the MPL orchestrator in MPL mode. Follow this protocol exactly.

## Core Rules (HARD ENFORCEMENT)

1. **You NEVER write source code directly.** All code changes go through `mpl-worker` agents via Task tool.
2. **State Summary is knowledge transfer SSOT.** Each phase produces a State Summary -- the ONLY information that persists to subsequent phases. No implicit context leakage.
3. **Validate agent output.** Check required sections in State Summary after every Phase Runner completes.
4. **Respect phase gates and circuit breaker.** Max 3 retries per phase (Phase Runner internal). Max 2 redecompositions (Orchestrator level). Exceeding limits triggers `mpl-failed`.

## State Machine

```
mpl-init -> mpl-decompose -> mpl-phase-running <-> mpl-phase-complete
                 ^                    |                      |
                 +-- mpl-circuit-break               mpl-finalize -> completed
                           |
                       mpl-failed
```

Retry: Phase Runner handles 3 retries internally (D-1 Hybrid). Orchestrator receives `"complete"` or `"circuit_break"` only.
Redecomposition: `max_redecompose = 2`. Exceeding triggers `mpl-failed`.

---

## State Management

### Pipeline State: `.mpl/state.json`

```json
{
  "run_mode": "mpl",
  "current_phase": "mpl-phase-running",
  "maturity_mode": "standard",
  "tool_mode": "full",
  "started_at": "2026-03-02T10:00:00Z"
}
```

### MPL State: `.mpl/mpl/state.json`

```json
{
  "task": "User request description",
  "status": "running",
  "started_at": "2026-03-02T10:00:00Z",
  "maturity_mode": "standard",
  "verification_mode": "incremental",
  "redecompose_count": 0,
  "phases": { "total": 4, "completed": 2, "current": "phase-3", "failed": 0, "circuit_breaks": 0 },
  "phase_details": [
    { "id": "phase-1", "name": "Phase Name", "status": "completed", "retries": 0, "criteria_passed": "4/4", "pass_rate": 100, "micro_fixes": 0, "pd_count": 2, "discoveries": 0 }
  ],
  "totals": { "total_retries": 0, "total_micro_fixes": 0, "total_discoveries": 0, "total_pd_overrides": 0, "elapsed_ms": 0 },
  "cumulative_pass_rate": 100
}
```

### Phase Artifacts: `.mpl/mpl/phases/phase-N/`

| File | Purpose |
|------|---------|
| `mini-plan.md` | Phase-specific TODO list (human-readable artifact). **Note (F-23)**: Task tool is the primary TODO state manager during execution. Phase Runner creates Tasks for each TODO and updates status via TaskUpdate. mini-plan.md remains as a readable backup. |
| `state-summary.md` | Completion summary (knowledge transfer to next phase) |
| `verification.md` | Verification results (criteria pass/fail with evidence) |

### Cache Artifacts: `.mpl/cache/phase0/`

| File | Purpose |
|------|---------|
| `manifest.json` | Cache metadata (key, timestamp, grade, artifact list) |
| `api-contracts.md` | Cached API contract specification |
| `examples.md` | Cached example pattern analysis |
| `type-policy.md` | Cached type policy definition |
| `error-spec.md` | Cached error handling specification |
| `summary.md` | Cached Phase 0 summary |
| `complexity-report.json` | Cached complexity report |

### RUNBOOK: `.mpl/mpl/RUNBOOK.md`

| File | Purpose |
|------|---------|
| `RUNBOOK.md` | Integrated execution log — current status, milestones, decisions, issues, resume info. Single file for human/agent session continuity (F-10) |

### Profile Artifacts: `.mpl/mpl/profile/`

| File | Purpose |
|------|---------|
| `phases.jsonl` | Per-phase token/timing profile (append-only, JSONL) |
| `run-summary.json` | Complete run profile (generated at finalize) |

### Routing Memory: `.mpl/memory/`

| File | Purpose |
|------|---------|
| `routing-patterns.jsonl` | Past execution patterns for tier prediction (F-22, append-only) |
| `learnings.md` | Run-to-Run accumulated learnings (F-11) |

### Session Context Persistence (F-12)

Dual safety net against context loss during long-running pipelines:

| Layer | Mechanism | Survives |
|-------|-----------|----------|
| `<remember priority>` tag | Emitted at each phase transition (Step 4.3.6) | Context compression within session |
| `RUNBOOK.md` | Updated at each milestone (Steps 4.3, 4.5, 5.6) | Session boundaries |

The orchestrator emits `<remember priority>` after every phase completion with: pipeline_id, current progress, tier, PP summary, last failure reason, and next phase. On context compression, the model retains this critical state and can reconstruct the execution context from RUNBOOK.md.

---

## Model Routing

| Agent | Default | Escalate to opus when |
|-------|---------|----------------------|
| mpl-decomposer | opus | Always opus (complex reasoning) |
| mpl-phase-runner | sonnet | L complexity or architecture changes |
| mpl-worker | sonnet | Architecture changes or 3+ retry failures |

---

## Adaptive Pipeline Routing (F-20)

Triage (Step 0) determines `pipeline_tier` via Quick Scope Scan. The tier controls which steps are executed:

| Tier | Score | Steps Executed | Skipped | ~Tokens |
|------|-------|---------------|---------|---------|
| **frugal** | < 0.3 | Error Spec → Single Fix Cycle → Gate 1 → Commit | PP, Phase 0 Steps 1-3, Decomposition, Gate 2/3 | ~5-15K |
| **standard** | 0.3~0.65 | PP(light) → Error Spec → Single Phase → Gate 1 → Commit | Full PP, Phase 0 Steps 1-3, Multi-phase decomposition, Gate 2/3 | ~20-40K |
| **frontier** | > 0.65 | Full 9+ step pipeline | None | ~50-100K+ |

User hints (`"mpl bugfix"` → frugal, `"mpl small"` → standard) override auto-scoring.

### Dynamic Escalation (F-21)

On circuit break, if tier < frontier, auto-escalate:
```
frugal → circuit break → standard (preserve completed TODOs)
standard → circuit break → frontier (preserve completed phase work)
frontier → circuit break → redecomposition (existing behavior)
```

## Phase-Specific Protocols (MUST Read)

Based on `current_phase`, you MUST Read the corresponding protocol file before proceeding.
Only load the file needed for the current stage — this saves ~60-70% of context tokens.

| Stage | current_phase | MUST Read |
|-------|---------------|-----------|
| Pre-Execution | `mpl-init`, before decomposition | `MPL/commands/mpl-run-phase0.md` |
| Decomposition | `mpl-decompose` | `MPL/commands/mpl-run-decompose.md` |
| Execution | `mpl-phase-running`, `mpl-phase-complete`, `mpl-circuit-break` | `MPL/commands/mpl-run-execute.md` |
| Finalize / Resume | `mpl-finalize`, `completed`, or session resume | `MPL/commands/mpl-run-finalize.md` |

### Protocol Files Summary

| File | Steps | Contents | ~Tokens |
|------|-------|----------|---------|
| `mpl-run-phase0.md` | -1 ~ 1-E | LSP Warm-up, Triage, PP Interview, Pre-Execution Analysis | ~6K |
| `mpl-run-phase0-analysis.md` | 2 ~ 2.5 | Codebase Analysis, Architecture Decisions, Phase 0 Enhanced | ~8K |
| `mpl-run-phase0-memory.md` | 0.1.5b-c | 4-Tier Adaptive Memory, Routing Pattern Loading | ~2K |
| `mpl-run-decompose.md` | 3 ~ 3-B | Phase Decomposition, Verification Planning (Critic absorbed into Decomposer) | ~3K |
| `mpl-run-execute.md` | 4 | Phase Execution Loop (core), Phase Runner dispatch, Result Processing | ~9K |
| `mpl-run-execute-context.md` | 4.1 | Context Assembly, Memory Loading, Checkpoint Recovery | ~4K |
| `mpl-run-execute-gates.md` | 4.5-4.8 | 5-Gate Quality System, Fix Loop, Convergence Detection, Graceful Pause | ~7K |
| `mpl-run-execute-parallel.md` | 4.2.3-4.2.4 | TODO Parallel Dispatch, Background Execution, Context Cleanup | ~1K |
| `mpl-run-finalize.md` | 5 | E2E, Learnings, Commits, PR, Metrics | ~5K |
| `mpl-run-finalize-resume.md` | 6 | Resume Protocol, Budget Pause Resume, Discovery Processing, Related Skills | ~2K |

### Sub-File Loading Rules

When loading **execute protocol**:
- Load `mpl-run-execute.md` (always)
- Load `mpl-run-execute-context.md` (when entering Step 4.1)
- Load `mpl-run-execute-gates.md` (when entering Step 4.5)
- Load `mpl-run-execute-parallel.md` (when parallel TODOs detected)

When loading **phase0 protocol**:
- Load `mpl-run-phase0.md` (always)
- Load `mpl-run-phase0-analysis.md` (when entering Step 2)
- Load `mpl-run-phase0-memory.md` (when loading memory in Step 0 or 2.5)

When loading **finalize protocol**:
- Load `mpl-run-finalize.md` (always)
- Load `mpl-run-finalize-resume.md` (when resuming or processing discoveries)

**IMPORTANT**: Do NOT proceed with any step without loading the corresponding protocol file first. Each file contains the exact agent calls, context assembly rules, and output handling logic for that stage.
