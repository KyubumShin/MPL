/**
 * EXAMPLE migration template — v3 → v4.
 *
 * **NOT REGISTERED**: the `.example.` suffix means
 * `hooks/lib/migrations/index.mjs` will not pick this file up. It exists
 * so future authors can copy the shape without inventing it from scratch.
 *
 * To author a real v3 → v4 migration:
 *   1. Copy this file to `v3-to-v4.mjs` (drop `.example.`).
 *   2. Bump `CURRENT_SCHEMA_VERSION` in `hooks/lib/mpl-state.mjs` to 4.
 *   3. Register the new module in `hooks/lib/migrations/index.mjs`.
 *   4. Add a unit test that feeds a v3 state through `readState` and
 *      asserts the v4 shape.
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
  from: 3,
  to: 4,
  description: 'EXAMPLE — additive backfill (replace with real change)',
  migrate(state, _cwd) {
    const merged = { ...state };

    // Example: backfill a hypothetical new field. Replace with the actual
    // change when used; the registry will not run this stub because the
    // file is not imported by index.mjs.
    if (typeof merged.example_new_field !== 'number') {
      merged.example_new_field = 0;
    }

    merged.schema_version = 4;
    return merged;
  },
};
