/**
 * Migration registry for `state.json` schema versions (H8 / #116).
 *
 * Each entry implements the contract:
 *   { from: int, to: int, description: string,
 *     migrate(state, cwd) -> state }
 *
 * `runMigrations(state, cwd, target)` walks the registry from the state's
 * current `schema_version` (defaults to 1 when absent — the pre-P2-6 era)
 * up to `target`, applying each matching entry exactly once. The walk is
 * idempotent: if `state.schema_version >= target` the function returns the
 * input unchanged.
 *
 * **File naming**: `v{from}-to-v{to}.mjs` is registered. Anything with
 * `.example.` in the name is intentionally excluded so future authors can
 * keep templates here without risking accidental load. See
 * `docs/schemas/migration-policy.md` for the authoring workflow.
 */

import v1ToV2 from './v1-to-v2.mjs';
import v2ToV3 from './v2-to-v3.mjs';

/**
 * Ordered registry. Add new entries here when bumping
 * `CURRENT_SCHEMA_VERSION` in `hooks/lib/mpl-state.mjs`.
 */
export const MIGRATIONS = Object.freeze([
  v1ToV2,
  v2ToV3,
]);

/**
 * Apply every registered migration whose `from` matches the current
 * `schema_version`, in order, until no further migration applies or the
 * target version is reached.
 *
 * Pure with respect to its inputs — does NOT persist to disk. The caller
 * (`readState` in `mpl-state.mjs`) decides when to write the migrated
 * state back.
 *
 * @param {object} state - parsed state.json (must be a plain object)
 * @param {string} cwd - working directory (for migrations that read
 *                       sibling files like `.mpl/mpl/state.json`)
 * @param {number} target - desired terminal schema_version
 * @returns {object} migrated state, or the input if already at target
 */
export function runMigrations(state, cwd, target) {
  if (!state || typeof state !== 'object') return state;

  let current = state;
  // Cap iterations defensively — even if a migration mis-bumped its `to`
  // field, we never loop more than the registry length.
  const safety = MIGRATIONS.length + 1;
  for (let i = 0; i < safety; i++) {
    const fromVersion = current.schema_version ?? 1;
    if (fromVersion >= target) return current;
    const next = MIGRATIONS.find((m) => m.from === fromVersion);
    if (!next) {
      // No migration can advance us further — leave as-is. The caller's
      // read path (and G3 I8) decides whether this is an error.
      return current;
    }
    if (next.to > target) {
      // Wouldn't normally happen — registry is monotonic — but if a
      // future entry leaps past target we still stop at target by
      // declining to apply it.
      return current;
    }
    current = next.migrate(current, cwd);
    if (typeof current?.schema_version !== 'number' || current.schema_version <= fromVersion) {
      // Migration bug: did not advance schema_version. Refuse to loop.
      return current;
    }
  }
  return current;
}
