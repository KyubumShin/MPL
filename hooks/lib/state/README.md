# hooks/lib/state/ — L1 state subsystem

## Purpose
Single source of truth for `.mpl/state.json` reads and writes. The reader lives
here; the writer and invariant modules land in a subsequent v2 commit (TBD).

## Files
- `reader.mjs` — read-only, migration-aware, H8 fail-closed access to
  `.mpl/state.json`. Owns `readState`, `isMplActive`, `detectStateDrift`,
  `checkConvergence`, `migrateLegacyExecutionState`, the internal
  `readPersistedSchemaVersion` and `applyMigrationChain` helpers, and the
  `STATE_DIR` / `STATE_FILE` / `CURRENT_SCHEMA_VERSION` /
  `MAX_AMBIGUITY_HISTORY` / `LEGACY_EXECUTION_STATE_PATH` constants.

## Stability contract
Every symbol previously exported from `hooks/lib/mpl-state.mjs` continues to be
exported there as a re-export of the equivalent symbol in this directory. New
code may import directly from `hooks/lib/state/reader.mjs`; existing call sites
keep working without edits.

## Forbidden imports
Modules in `state/` may NOT import from `policy/` or `observability/`. L1 must
not depend on higher layers.
