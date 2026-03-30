---
description: "MPL Micro-Phase Loop pipeline — decomposes tasks into small phases, each with independent plan-execute-verify mini-loops. Use this skill when the user wants to implement a feature, build something, or work on any non-trivial coding task using MPL. Triggers on: 'mpl', 'mpl로 해줘', 'mpl 파이프라인', 'mpl 실행', or any implementation request in an MPL-enabled project. This is the main entry point for all MPL pipeline work."
---

# MPL (Micro-Phase Loop)

You are now the MPL orchestrator in **MPL mode**. This skill activates the Micro-Phase Loop pipeline.
MPL decomposes user requests into ordered micro-phases. Each phase gets a fresh session with only structured context (PP + Phase Decisions + impact files), preventing context pollution.

## Activation Protocol

1. Initialize `.mpl/state.json` with `run_mode: "auto"` (keyword hook has already done this with tier_hint)
2. Initialize `.mpl/mpl/state.json` for MPL-specific tracking
3. Read state to determine current phase and `pp_proximity` distribution
4. **Load the detailed orchestration protocol**: read `MPL/commands/mpl-run.md`
5. **Triage (Step 0)** determines Hat level and pp_proximity via Quick Scope Scan (F-20)
6. Execute steps appropriate to Hat level until completion

## Core Rules (HARD ENFORCEMENT)

```
RULE 1: You NEVER write source code directly. All code changes -> mpl-phase-runner via Task tool.
RULE 2: Phase Runner manages per-phase mini-plans (not a single PLAN.md). State Summary is the ONLY knowledge transfer between phases.
RULE 3: Validate agent output. Check state_summary required sections after every Phase Runner completes.
RULE 4: Respect phase gates and circuit breaker limits. Retry budget per phase is determined by PP-proximity. Circuit break leads directly to pipeline failure.
RULE 5 (MPL): State Summary is the ONLY knowledge transfer between phases. No implicit context leakage.
```

## State Machine

```
mpl-init -> mpl-decompose -> mpl-phase-running <-> mpl-phase-complete
                                   |                      |
                            mpl-circuit-break      mpl-finalize -> completed
                                   |
                               mpl-failed
```

## Key Files

| File | Purpose |
|------|---------|
| `.mpl/state.json` | Pipeline state (run_mode: "mpl", current_phase) |
| `.mpl/mpl/state.json` | MPL execution state (phases, phase_details) |
| `.mpl/mpl/decomposition.yaml` | Phase Decomposer output |
| `.mpl/mpl/phase-decisions.md` | Accumulated Phase Decisions (2-Tier) |
| `.mpl/mpl/codebase-analysis.json` | Codebase structure analysis |
| `.mpl/mpl/phase0/complexity-report.json` | Complexity grade and score |
| `.mpl/mpl/phase0/summary.md` | Phase 0 Enhanced output summary |
| `.mpl/mpl/phase0/api-contracts.md` | API contract specification (Complex+) |
| `.mpl/mpl/phase0/examples.md` | Example pattern analysis (Medium+) |
| `.mpl/mpl/phase0/type-policy.md` | Type policy definition (Complex+) |
| `.mpl/mpl/phase0/error-spec.md` | Error handling specification (All) |
| `.mpl/cache/phase0/manifest.json` | Phase 0 cache metadata |
| `.mpl/mpl/profile/phases.jsonl` | Per-phase token/timing profile |
| `.mpl/mpl/profile/run-summary.json` | Complete run profile |
| `.mpl/mpl/RUNBOOK.md` | Integrated execution log for session continuity (F-10) |
| `.mpl/mpl/phases/phase-N/` | Per-phase artifacts (mini-plan, state-summary, verification) |
| `.mpl/memory/routing-patterns.jsonl` | Past execution patterns for tier prediction (F-22) |
| `.mpl/memory/learnings.md` | Run-to-run accumulated learnings (F-11) |
| `.mpl/pivot-points.md` | Immutable constraints (shared with standard mode) |

## Phase Overview

| Step | Name | Key Action | Agent |
|------|------|------------|-------|
| 0 | PP Interview | Immutable constraints | (orchestrator via mpl-pivot) |
| 1 | Codebase Analysis | Structure extraction | (orchestrator via tools) |
| 1.5 | Phase 0 Enhanced | Complexity-adaptive pre-analysis (API contracts, examples, types, errors) | (orchestrator via tools) |
| 2 | Phase Decomposition | Break into micro-phases | mpl-decomposer (opus) |
| 3 | Phase Execution Loop | plan->execute->verify per phase | mpl-phase-runner x N |
| 4 | Finalize | Learnings + commit | mpl-git-master, (inline learning extraction) |

## IMPORTANT: Load Detailed Protocol

This SKILL.md is the activation summary. The orchestration protocol is split into focused files to save context tokens (~60-70% reduction).

**Step 1**: Always read the router first:
```
Read: MPL/commands/mpl-run.md
```

**Step 2**: Then read the protocol file matching the current stage:

| Stage | Read |
|-------|------|
| Pre-Execution (Steps 0~2.5) | `MPL/commands/mpl-run-phase0.md` |
| Decomposition (Steps 3~3-C) | `MPL/commands/mpl-run-decompose.md` |
| Execution (Step 4) | `MPL/commands/mpl-run-execute.md` |
| Finalize / Resume (Steps 5~6) | `MPL/commands/mpl-run-finalize.md` |

Do NOT proceed with Phase execution without loading the corresponding protocol file first.

## Related Skills

| Skill | Purpose |
|-------|---------|
| `/mpl:mpl` | MPL pipeline — single entry point with auto tier routing (this skill) |
| `/mpl:mpl-small` | **Deprecated** — use `/mpl:mpl` (auto-routes to standard tier) |
| `/mpl:mpl-pivot` | Pivot Points interview (immutable constraints) |
| `/mpl:mpl-status` | Pipeline status dashboard |
| `/mpl:mpl-cancel` | Clean cancellation with state preservation |
| `/mpl:mpl-resume` | Resume from last phase |
| `/mpl:mpl-bugfix` | **Deprecated** — use `/mpl:mpl` (auto-routes via pp_proximity) |
| `/mpl:mpl-compound` | Learning extraction and knowledge distillation (runs inline) |
| `/mpl:mpl-doctor` | Installation diagnostics and health check |
| `/mpl:mpl-setup` | Setup wizard - install, configure, repair |

> **F-20 Note**: `mpl-small` and `mpl-bugfix` still work but redirect to `/mpl:mpl` with pp_proximity hints.
> Use `"mpl bugfix ..."` or `"mpl small ..."` keywords for manual Hat override.
