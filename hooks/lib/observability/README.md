# hooks/lib/observability/ — L1 observability

## Purpose
Telemetry, runbook, and hook-trace utilities — read-only side effects whose
sole job is diagnostics, audit trails, and live registry reflection. These
modules observe the system; they never decide policy and never mutate state.

## Status
Empty in v2 commit #1 (this README only). Candidates for migration:

- `mpl-profile.mjs` → `observability/profile.mjs` (token telemetry)
- `mpl-runbook.mjs` → `observability/runbook.mjs` (G2 `RUNBOOK.md` rows)
- `mpl-hook-trace.mjs` → `observability/hook-trace.mjs` (live `hooks.json`
  registry reflection for state-invariant checks)

## Stability contract
Observability modules may import from `state/` (read-only) and config. They
must NOT import from `policy/` — observability is L1, policy is L2, and L1 is
forbidden from depending on L2.
