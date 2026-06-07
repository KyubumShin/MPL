# hooks/lib/observability/ — L1 observability

## Purpose
Telemetry, runbook, and hook-trace utilities — read-only side effects whose
sole job is diagnostics, audit trails, and live registry reflection. These
modules observe the system; they never decide policy and never mutate state
through `policy/`.

## Status (Move #12)
Two modules now ship:

- `signals.mjs` — absorbs seven signal/recorder hooks
  (sentinel S0/S1/S3/PP-File, soft-signal-emit, gate-recorder,
  discovery-scanner, keyword-detector). Closes the eval finding on S1/S3
  by gating on the new `observability.sentinels.subagent_type_filter` knob.
  Also exports the engine-facing `emit(payload)` used by
  `mpl-engine.mjs` Step 8 (telemetry sink, fail-soft, sink path via
  `MPL_SIGNALS_LOG` env).
- `trackers.mjs` — absorbs three tracker hooks
  (context-monitor, compaction-tracker, tool-tracker). Sub-handlers
  return `tracked` decisions carrying `stateMutations`, `fileWrites`,
  and `intents` so wrappers stay tiny.

Future candidates (not migrated yet):
- `mpl-profile.mjs` → `observability/profile.mjs` (token telemetry)
- `mpl-runbook.mjs` → `observability/runbook.mjs`
- `mpl-hook-trace.mjs` → `observability/hook-trace.mjs`

## Subagent-type filter (CLOSES EVAL FINDING)
Pre-Move-#12, S1 and S3 ran on every `Task|Agent` PostToolUse and did
recursive filesystem scans for unrelated subagents (debate, validate-seed,
ambiguity-gate, …). After Move #12 they read the YAML knob:

```yaml
observability:
  sentinels:
    subagent_type_filter:
      s0: ['mpl-seed-generator', 'mpl:mpl-seed-generator',
           'mpl-phase-runner',   'mpl:mpl-phase-runner']
      s1: ['mpl-phase-runner',   'mpl:mpl-phase-runner']
      s3: ['mpl-test-agent',     'mpl:mpl-test-agent']
```

Set a list to `null` to disable the filter (legacy "fire for every Task")
or `["__none__"]` to opt out entirely. File-write tools (Edit/Write/MultiEdit)
bypass the filter — the existing path gates (e.g. `.mpl/seeds/*.yaml`) are
sufficient.

## Stability contract
Observability modules may import from `state/` (read-only) and config. They
must NOT import from `policy/` — observability is L1, policy is L2, and L1
is forbidden from depending on L2.
