# `.mpl/state.json` Migration Policy (H8, v0.18.1)

> **Status**: Active — H8 (#116) defines how `state.schema_version`
> changes propagate through the codebase. Companion to
> `docs/schemas/state.md` (the frozen schema) and `hooks/lib/migrations/`
> (the executable registry).
>
> **Source-of-truth constant**: `CURRENT_SCHEMA_VERSION` in
> `hooks/lib/mpl-state.mjs`.

## Why this exists

`state.json.schema_version` was added in P2-6 (#84) to unify the previously
split state files. Before H8 it was effectively a marker only: `readState`
ran the v1→v2 merge as a hard-coded branch and silently passed through any
future version. G3 invariant I8 (#108) flagged newer-than-supported writes
as warn — but a stale plugin reading a state from a fresher writer would
still proceed and could misinterpret renamed or removed fields.

H8 makes the version contract enforceable end-to-end: writers commit to a
bump policy, the read path runs migrations from a registry, and
out-of-range versions fail closed.

## Bump policy (semantic)

The schema version is a single integer. Bumps are classified by the kind
of change to the state shape:

| Change | Kind | Action | Example |
|---|---|---|---|
| Add a new optional field with a safe default | **Additive** | Bump `CURRENT_SCHEMA_VERSION`. Migration script is a one-line backfill (or a no-op if the default is `null`/`[]`). | Adding `state.fix_loop_history: []` (G5 #114). |
| Add a new top-level subtree | **Additive** | Bump + initialize the subtree shape. | Adding `state.research` (v0.14). |
| Rename an existing field | **Breaking** | Bump + migration must read the old name and write the new one. Drop the old name only after one stable release. | `current_phase` rename across exp16. |
| Change the meaning of an existing field (units, enum) | **Breaking** | Bump + migration translates each prior value to the new domain. Hand-write the mapping — no implicit identity. | `session_status` enum widening (#109 G4 added `verification_hang`). |
| Remove a field | **Breaking** | Bump + migration drops the key cleanly. Document the removal in this file. | (none yet). |

### What this means in practice

- **Additive** bump = patch number on the plugin (e.g. `0.18.1 → 0.18.2`).
  Old hooks reading a fresh state see the new field as `undefined`; treat
  it as the default. New hooks reading an old state run the migration on
  first read and the field is backfilled.
- **Breaking** bump = minor number on the plugin (e.g. `0.18.x → 0.19.0`).
  A migration script is **mandatory** — no in-place rename, no field
  removal without a translation. Without a registered migration, a writer
  bumping `CURRENT_SCHEMA_VERSION` will trip its own G3 I8 on the next
  read.

## Migration registry

`hooks/lib/migrations/index.mjs` exports an ordered list of migration
entries:

```js
{
  from: 1,                      // schema_version BEFORE migration
  to: 2,                        // schema_version AFTER migration
  description: 'Unify split state files (P2-6 / #84)',
  migrate(state, cwd) {         // pure function (cwd for legacy I/O)
    // ... return new state object with state.schema_version = to
  }
}
```

`readState(cwd)` resolves the migration chain:

1. Parse `.mpl/state.json`. If `schema_version` is absent, treat as `1`
   (the pre-P2-6 default).
2. If `schema_version > CURRENT_SCHEMA_VERSION` → return `null` and log
   `[MPL state] schema_version=N exceeds supported MAX=M; upgrade plugin`.
   This is **fail-closed**: a stale plugin will not act on data shapes
   it can't reason about. Operationally, this surfaces as the same
   "state file unreadable" path that already exists for corrupt JSON, so
   downstream hooks naturally degrade rather than misinterpret.
3. If `schema_version < CURRENT_SCHEMA_VERSION` → walk the registry,
   apply each migration whose `from` matches the current version, and
   persist the result atomically.

Migrations are run **at most once per stale read**: each migration writes
back to disk with the new `schema_version`, so subsequent reads
short-circuit. The chain runner is idempotent — calling it on
already-current state is a no-op.

## File naming

Each migration lives in `hooks/lib/migrations/v{from}-to-v{to}.mjs` and
exports a default object matching the registry shape above.
`index.mjs` imports them in order.

Files with `.example.` in the name (e.g.
`v2-to-v3.example.mjs`) are **not** registered — they are templates for
future authors and the registry deliberately ignores them so a stale
example can never run against real state.

## Authoring a new migration

1. Copy `v2-to-v3.example.mjs` to `v{N}-to-v{N+1}.mjs` and fill in the
   `migrate` body. Keep it pure: same input → same output, no clock or
   network reads.
2. Bump `CURRENT_SCHEMA_VERSION` in `hooks/lib/mpl-state.mjs` to `N+1`.
3. Register the migration in `hooks/lib/migrations/index.mjs`.
4. Add a unit test in `hooks/__tests__/mpl-migrations.test.mjs` that
   feeds a `from`-shaped state object through `readState` and asserts the
   `to` shape.
5. Update the matrix at the top of this file with the change kind.
6. If the bump is breaking, also update `docs/schemas/state.md` and any
   consumer hooks; the G3 I8 invariant will fail in CI until both sides
   agree.

## Rollback

State files are atomic — `writeState` writes to a temp path and renames.
A failed migration leaves the original file in place because the
migration chain only persists on success. A user who discovers a bad
migration can:

1. Pin the plugin to the prior version.
2. Restore from `.mpl/archive/{pipeline_id}-legacy-execution-state.json`
   if a legacy file was archived during a v1→v2 migration.
3. Manually reset by deleting `.mpl/state.json` (loses pipeline progress;
   only valid if the pipeline can be re-run from scratch).

There is no automatic downgrade path. A bumped `schema_version` is a
one-way commitment.

## See also

- `hooks/lib/mpl-state.mjs` — `readState` + `CURRENT_SCHEMA_VERSION`.
- `hooks/lib/migrations/` — registry + per-version scripts.
- `hooks/lib/mpl-state-invariant.mjs#checkI8` — G3 invariant that fires
  when `schema_version` exceeds what the running hook supports
  (defense-in-depth alongside `readState`'s fail-closed return).
- `docs/schemas/state.md` — frozen field schema.
