# `.mpl/metrics/e2e-recovery.jsonl` Schema

> **Status**: Stable public schema, frozen as of v0.17.1 (#92).
>
> **Producer**: `mpl_diagnose_e2e_failure` in
> `mcp-server/src/tools/e2e-diagnose.ts`.
>
> **Source-of-truth constants/types**:
> `mcp-server/src/lib/e2e-diagnoser.ts`
> (`RECOVERY_METRICS_PATH`, `RecoveryMetricRecord`, `PROMPT_VERSION`).

## File Contract

Path: `.mpl/metrics/e2e-recovery.jsonl`

Format: JSON Lines. Each non-empty line is one JSON object emitted after one
`mpl_diagnose_e2e_failure` call. The file is append-only from MPL's point of
view; external analysis tools should read all complete lines and ignore blank
lines.

Emission is best-effort. The diagnoser return value remains the primary MCP
contract, so metrics I/O failures are swallowed by the producer and are not
reported to the caller.

## Record Shape

Example:

```json
{"ts":"2026-05-02T00:00:00.000Z","classification":"A","confidence":0.87,"iter":1,"prompt_version":"v1-2026-04-19"}
```

| Field | Type | Required | Semantics |
|---|---|---|---|
| `ts` | ISO-8601 string | Yes | Wall-clock timestamp from `new Date().toISOString()` when the MCP tool records the diagnosis. |
| `classification` | `"A"` \| `"B"` \| `"C"` \| `"D"` | Yes | Diagnoser class: `A` spec gap, `B` test bug, `C` missing capability, `D` flake. |
| `confidence` | number `0.0..1.0` | Yes | Diagnoser confidence after parser clamping. |
| `iter` | integer `0..max_iter` | Yes | Recovery iteration counter written as `prev_iter + iter_hint`; current protocol max is `2`. |
| `prompt_version` | string | Yes | Classifier prompt contract. Current frozen value: `v1-2026-04-19`. |

JSON object key order is not part of the contract. Consumers must read fields
by name.

## Stability Policy

This file is an MPL-owned public surface because external tooling such as
harness analysis can consume it.

| Change | Compatibility | Required action |
|---|---|---|
| Add a new optional field | Additive | Patch release is sufficient. Existing consumers must ignore unknown fields. |
| Remove a field | Breaking | Minor release, breaking-change label, and migration/compatibility note. |
| Change a field's meaning or units | Breaking | Minor release, breaking-change label, and explicit consumer migration guidance. |
| Change `prompt_version` | Classifier contract change | Bump the value whenever prompt semantics change. Comparative analyses must group by exact `prompt_version` or refuse mixed-version comparisons. |

If the record shape needs a breaking evolution beyond `prompt_version`, prefer
adding an explicit additive discriminator first, such as `schema_version`, and
keep the old fields during one stable migration window.

## Scope Boundaries

MPL guarantees the emitted JSONL shape and stability policy above. Downstream
labelers, agreement-rate calculations, experiment dashboards, and promotion
criteria remain outside this repository unless they are implemented here.

## See Also

- `mcp-server/src/lib/e2e-diagnoser.ts` - producer types and append helper.
- `mcp-server/src/tools/e2e-diagnose.ts` - MCP handler that emits records.
- `commands/references/e2e-recovery.md` - finalize recovery protocol.
- `docs/roadmap/0.16-exp12-plan.md` - exp12 metrics context.
