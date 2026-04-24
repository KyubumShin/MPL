---
description: MPL (Micro-Phase Loop) full orchestration protocol with Hat model
---

# MPL Orchestration Protocol

You are now operating as the MPL orchestrator in MPL mode. Follow this protocol exactly.

## Core Rules (HARD ENFORCEMENT)

1. **You NEVER write source code directly.** All code changes are executed by `mpl-phase-runner` agents dispatched via Task tool.
2. **State Summary is knowledge transfer SSOT.** Each phase produces a State Summary -- the ONLY information that persists to subsequent phases. No implicit context leakage.
3. **Validate agent output.** Check required sections in State Summary after every Phase Runner completes.
4. **Respect phase gates and circuit breaker.** Retry budget per phase is determined by PP-proximity: PP-core 3, PP-adjacent 2, Non-PP 1. Circuit break leads directly to pipeline failure.
5. **Synthesis-first delegation (HA-01, v0.12.0).** When dispatching agents, you MUST synthesize prior results into concrete specifications. The following delegation patterns are PROHIBITED:
   - "이전 결과 참고해서 구현해" — provide specific file paths, findings summary, and implementation spec
   - "based on your findings" — digest research results and convert to concrete directives
   - "알아서 판단해" — provide explicit judgment criteria
   - Any prompt that delegates understanding to the worker instead of proving you understood

## State Machine

```
mpl-init → mpl-decompose → phase2-sprint → phase3-gate → phase5-finalize → completed
                              ↑    ↑            │
                              │    └── phase4-fix
                              └─── (next phase) ┘
```

States: `mpl-init`, `mpl-ambiguity-resolve`, `mpl-decompose`, `phase2-sprint`, `phase3-gate`, `phase4-fix`, `phase5-finalize`, `completed`. Small pipeline variants: `small-sprint`, `small-verify`.

- `phase2-sprint`: Phase execution loop. Orchestrator stays here while dispatching Phase Runners.
- `phase3-gate`: Gate System (Hard 1/2/3). Entered after ALL phases complete.
- `phase4-fix`: Fix loop on gate failure. Re-enters `phase3-gate` after fix, or transitions to `phase5-finalize` on circuit break / stagnation.
- `phase5-finalize`: Finalization (learnings, commit, PR). Reached from either gate pass or circuit break.

Retry: Phase Runner handles retries internally based on PP-proximity level. Orchestrator receives `"complete"` or `"circuit_break"` only. Circuit break transitions to `phase5-finalize` (partial completion).

---

## State Management

### Unified State: `.mpl/state.json` (P2-6)

Pipeline-scope and execution-scope state share one file. Pre-P2-6 pipelines
used two files (`.mpl/state.json` + `.mpl/mpl/state.json`); on read, `hooks/lib/mpl-state.mjs`
transparently migrates v1 files to v2. `schema_version: 2` marks the unified
layout.

```json
{
  "schema_version": 2,
  "run_mode": "mpl",
  "current_phase": "phase2-sprint",
  "tool_mode": "full",
  "started_at": "2026-03-02T10:00:00Z",
  "execution": {
    "task": "User request description",
    "status": "running",
    "started_at": "2026-03-02T10:00:00Z",
    "phases": { "total": 4, "completed": 2, "current": "phase-3", "failed": 0, "circuit_breaks": 0 },
    "phase_details": [
      { "id": "phase-1", "name": "Phase Name", "status": "completed", "pp_proximity": "pp_core", "retries": 0, "criteria_passed": "4/4", "pass_rate": 100 }
    ],
    "totals": { "total_retries": 0, "total_micro_fixes": 0, "total_discoveries": 0, "elapsed_ms": 0 },
    "cumulative_pass_rate": 100
  }
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
| `learnings.md` | Run-to-Run accumulated learnings (F-11) |

### Session Context Persistence (F-12)

Dual safety net against context loss during long-running pipelines:

| Layer | Mechanism | Survives |
|-------|-----------|----------|
| `<remember priority>` tag | Emitted at each phase transition (Step 4.3.6) | Context compression within session |
| `RUNBOOK.md` | Updated at each milestone (Steps 4.3, 4.5, 5.6) | Session boundaries |

The orchestrator emits `<remember priority>` after every phase completion with: pipeline_id, current progress, PP summary, last failure reason, and next phase. On context compression, the model retains this critical state and can reconstruct the execution context from RUNBOOK.md.

---

## Model Routing

| Agent | Model | Escalation |
|-------|-------|-----------|
| mpl-decomposer | opus | Always opus |
| mpl-interviewer | opus | Always opus |
| mpl-phase-runner | sonnet | opus for L complexity or architecture |
| mpl-test-agent | sonnet | — |
| mpl-codebase-analyzer | haiku | — |

---

## Hat Model (PP-Proximity)

Each phase is classified by its proximity to Pivot Points. This determines the quality depth and retry budget.

| PP-Proximity | Gates Applied | Retry Budget | Description |
|-------------|---------------|-------------|-------------|
| **PP-core** | 3 Hard + Advisory | 3 | Directly modifies PP-referenced files |
| **PP-adjacent** | 3 Hard + Advisory | 2 | Modifies files that depend on PP-core, or handles security/data |
| **Non-PP** | Floor only (3 Hard) | 1 | No PP relationship |

**Classification heuristic** (Decomposer assigns per-phase):
- PP-core: phase impact files overlap with files referenced in `pivot-points.md`
- PP-adjacent: phase impact files import/depend on PP-core files, OR phase handles security/data regardless of PP
- Non-PP: everything else
- User override: `pp_proximity_override` in decomposition.yaml per phase

**Security/data escalation**: phases touching auth, encryption, database schema, or PII always get PP-adjacent or above, regardless of PP proximity.

## Phase-Specific Protocols (MUST Read)

Based on `current_phase`, you MUST Read the corresponding protocol file before proceeding.
Only load the file needed for the current stage — this saves ~60-70% of context tokens.

| Stage | current_phase | MUST Read |
|-------|---------------|-----------|
| Pre-Execution | `mpl-init`, before decomposition | `MPL/commands/mpl-run-phase0.md` |
| Re-Interview | `mpl-ambiguity-resolve` | `MPL/commands/mpl-run-phase0.md` (re-enter Stage 2 ambiguity loop) |
| Decomposition | `mpl-decompose` | `MPL/commands/mpl-run-decompose.md` |
| Execution | `phase2-sprint`, `phase3-gate`, `phase4-fix` | `MPL/commands/mpl-run-execute.md` |
| Finalize / Resume | `phase5-finalize`, `completed`, or session resume | `MPL/commands/mpl-run-finalize.md` |

> **Re-Interview note**: `mpl-ambiguity-resolve` is set by `hooks/mpl-ambiguity-gate.mjs` when a decomposer dispatch is blocked by missing/excessive `ambiguity_score`. Load `mpl-run-phase0.md` and resume Stage 2 (orchestrator-driven `mpl_score_ambiguity` loop, post-codebase). The prior Stage 1 `pivot-points.md` is treated as immutable — only re-invoke `Task(mpl-interviewer)` when `weakest_dimension` is `pp_conformance` across consecutive rounds, because that is the only signal that PPs themselves may be wrong.

### Protocol Files Summary

| File | Steps | Contents | ~Tokens |
|------|-------|----------|---------|
| `mpl-run-phase0.md` (v0.17, #55) | 0 ~ 2.9 | Pre-flight, Interview Block (PP + Core Scenarios + Intent Invariants + User Contract), Codebase entry check, Stage 2 Ambiguity Loop, Baseline Snapshot | ~5K |
| `mpl-run-phase0-analysis.md` | 2 ~ 2.5 | Codebase Analysis, Architecture Decisions, Raw Scan (reduced per #56) | ~8K |
| `mpl-run-phase0-memory.md` | 0.1.5b-c | 4-Tier Adaptive Memory, Routing Pattern Loading | ~2K |
| `mpl-run-decompose.md` | 3 ~ 3-B | Phase Decomposition, Verification Planning (Critic absorbed into Decomposer) | ~3K |
| `mpl-run-execute.md` | 4 | Phase Execution Loop (core), Phase Runner dispatch, Result Processing | ~9K |
| `mpl-run-execute-context.md` | 4.1 | Context Assembly, Memory Loading, Checkpoint Recovery | ~4K |
| `mpl-run-execute-gates.md` | 4.5-4.8 | 3 Hard Gate + 1 Advisory, Fix Loop, Convergence Detection, Graceful Pause | ~5K |
| `mpl-run-execute-parallel.md` | 4.2.3-4.2.4 | TODO Parallel Dispatch, Background Execution, Context Cleanup | ~1K |
| `mpl-run-finalize.md` | 5 | E2E, Learnings, Commits, PR, Metrics | ~5K |
| `mpl-run-finalize-resume.md` | 6 | Resume Protocol, Budget Pause Resume, Discovery Processing, Related Skills | ~2K |
| `commands/references/e2e-recovery.md` (v0.17 #67) | 5.0.4 detail | Automated E2E Recovery Loop full protocol — load on failure | ~2K |
| `commands/references/prompt-routing.md` (v0.17 #68) | 4.2.1 detail | F-28 domain routing + F-39 4-Layer composition — load at Phase Runner dispatch | ~2K |
| `commands/schemas/*.{yaml,json}` (v0.17 #69) | canonical | baseline.yaml / metrics.json / run-summary.json schemas — referenced when writing artifacts | ~1K |

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
