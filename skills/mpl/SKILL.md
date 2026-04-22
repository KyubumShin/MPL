---
description: "MPL Micro-Phase Loop pipeline — decomposes tasks into small phases, each with independent plan-execute-verify mini-loops. Use this skill when the user wants to implement a feature, build something, or work on any non-trivial coding task using MPL. Triggers on: 'mpl', 'mpl로 해줘', 'mpl 파이프라인', 'mpl 실행', or any implementation request in an MPL-enabled project. This is the main entry point for all MPL pipeline work."
---

# MPL (Micro-Phase Loop)

You are now the MPL orchestrator in **MPL mode**. MPL decomposes user requests into ordered micro-phases. Each phase gets a fresh session with only structured context (PP + Phase Decisions + impact files), preventing context pollution.

## Activation Protocol

1. `.mpl/state.json` already initialized by the keyword-detector hook (`run_mode: "auto"`).
2. Initialize `.mpl/mpl/state.json` for MPL-specific tracking.
3. **Load the router**: `MPL/commands/mpl-run.md`. It reads `current_phase` from state and tells you which sub-protocol to load next.
4. Follow the sub-protocol to completion.

Do NOT proceed with phase execution before loading the protocol file matching the current stage.

## Core Rules (HARD ENFORCEMENT)

1. You NEVER write source code directly. All code changes → `mpl-phase-runner` via Task tool.
2. Phase Runner manages per-phase mini-plans. State Summary is the ONLY knowledge transfer between phases.
3. Validate agent output. Check required sections in state-summary after every Phase Runner completes.
4. Respect phase gates and circuit-breaker limits.
5. No implicit context leakage — downstream phases see only the prior phase's State Summary plus their own fresh seed.

## State Machine (v0.17)

```
mpl-init → mpl-decompose ⇌ mpl-ambiguity-resolve
          → phase2-sprint ⇌ phase3-gate ⇌ phase4-fix
          → phase5-finalize → completed
```

`mpl-ambiguity-resolve` is a re-entry point set by `hooks/mpl-ambiguity-gate.mjs` when the decomposer dispatch is blocked by the ambiguity score (#51). The router maps it back to Phase 0 Stage 2 for the orchestrator-driven ambiguity loop.

## Related Skills

| Skill | Purpose |
|-------|---------|
| `/mpl:mpl-pivot` | Pivot Points interview |
| `/mpl:mpl-status` | Pipeline status dashboard |
| `/mpl:mpl-cancel` | Clean cancellation with state preservation |
| `/mpl:mpl-resume` | Resume from last phase |
| `/mpl:mpl-doctor` | Installation diagnostics |
| `/mpl:mpl-setup` | Setup wizard |

> **Artifact paths and step tables** live in `commands/mpl-run.md` — the router is the single source of truth. Duplicating them here caused drift (pre-v0.17 this file still referenced `complexity-report.json`, `routing-patterns.jsonl`, and `pp_proximity` long after they were deleted).
