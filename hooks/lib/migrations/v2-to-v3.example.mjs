/**
 * EXAMPLE migration template — v2 → v3.
 *
 * **NOT REGISTERED**: the `.example.` suffix means
 * `hooks/lib/migrations/index.mjs` will not pick this file up. It exists
 * so future authors can copy the shape without inventing it from scratch.
 *
 * To author a real v2 → v3 migration:
 *   1. Copy this file to `v2-to-v3.mjs` (drop `.example.`).
 *   2. Bump `CURRENT_SCHEMA_VERSION` in `hooks/lib/mpl-state.mjs` to 3.
 *   3. Register the new module in `hooks/lib/migrations/index.mjs`.
 *   4. Add a unit test that feeds a v2 state through `readState` and
 *      asserts the v3 shape.
 *   5. If the change is breaking (rename / remove / semantic shift), also
 *      update `docs/schemas/state.md` and any consumer hooks.
 *
 * Reference: `docs/schemas/migration-policy.md`.
 *
 * The body below illustrates an additive backfill — the most common
 * shape: a new optional field gets seeded with its default whenever the
 * incoming state lacks it. Replace with the actual change when used.
 */

export default {
  from: 2,
  to: 3,
  description: 'EXAMPLE — additive backfill (replace with real change)',
  migrate(state, _cwd) {
    const merged = { ...state };

    // Example: backfill `fix_loop_history` (G5 #114).
    // Real authors should either replace this body or delete it entirely
    // and add their own fields — the registry will not run this stub
    // because the file is not imported by index.mjs.
    if (!Array.isArray(merged.fix_loop_history)) {
      merged.fix_loop_history = [];
    }

    merged.schema_version = 3;
    return merged;
  },
};
