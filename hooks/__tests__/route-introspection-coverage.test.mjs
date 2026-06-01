/**
 * MODULE_TO_HOOK_IDS ↔ dispatch.mjs ROUTES coverage test.
 *
 * Closes a manual-mapping drift gap: `lib/route-introspection.mjs#MODULE_TO_HOOK_IDS`
 * is hand-maintained alongside `lib/dispatch.mjs` ROUTES, and the only
 * symptom of a missing entry was a silent gap in `mpl-hook-trace`,
 * `mpl-design-hooks-table`, and `liveHooksFromRoutes()`.
 *
 * This test asserts the two registries stay in lockstep:
 *   (a) every registered route's `id` is a key in MODULE_TO_HOOK_IDS
 *   (b) every MODULE_TO_HOOK_IDS key is present in the live ROUTES registry
 *       (no orphan mappings for routes that were renamed/removed)
 *
 * Intentional empty mappings (`[]`) are allowed on either side — they are
 * declared coverage, not drift. Empty values mean "this route has no
 * pre-Move-#14 legacy hook-id surface" (e.g. `schemas.pivot-points` folded
 * into another validator, `reconcile.require` is additive/dormant).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { installRoutes, getRegistry } from '../lib/dispatch.mjs';
import { MODULE_TO_HOOK_IDS } from '../lib/route-introspection.mjs';

describe('MODULE_TO_HOOK_IDS coverage vs dispatch.mjs ROUTES', () => {
  it('every registered route id has a MODULE_TO_HOOK_IDS entry', async () => {
    await installRoutes();
    const routes = getRegistry();
    const missing = [];
    for (const spec of routes) {
      if (!Object.prototype.hasOwnProperty.call(MODULE_TO_HOOK_IDS, spec.id)) {
        missing.push(spec.id);
      }
    }
    assert.deepEqual(
      missing,
      [],
      `dispatch.mjs route id(s) without MODULE_TO_HOOK_IDS entry: ${missing.join(', ')}.\n` +
      `Add an entry in hooks/lib/route-introspection.mjs#MODULE_TO_HOOK_IDS — ` +
      `use an empty array [] if the route has no pre-Move-#14 legacy hook id ` +
      `(see schemas.pivot-points / reconcile.require for the documented shape).`,
    );
  });

  it('every MODULE_TO_HOOK_IDS key matches a registered route id', async () => {
    await installRoutes();
    const routes = getRegistry();
    const registeredIds = new Set(routes.map((r) => r.id));
    const orphans = [];
    for (const key of Object.keys(MODULE_TO_HOOK_IDS)) {
      if (!registeredIds.has(key)) orphans.push(key);
    }
    assert.deepEqual(
      orphans,
      [],
      `MODULE_TO_HOOK_IDS key(s) with no matching dispatch.mjs route: ${orphans.join(', ')}.\n` +
      `Either the route was renamed/removed (delete the mapping) or the spec is ` +
      `gated behind an import that didn't load in this test run.`,
    );
  });

  it('intentional empty mappings stay declared (schemas.pivot-points, reconcile.require)', () => {
    assert.ok(
      Object.prototype.hasOwnProperty.call(MODULE_TO_HOOK_IDS, 'schemas.pivot-points'),
      'schemas.pivot-points must remain declared (folded into mpl-validate-pp-schema)',
    );
    assert.deepEqual(MODULE_TO_HOOK_IDS['schemas.pivot-points'], []);

    assert.ok(
      Object.prototype.hasOwnProperty.call(MODULE_TO_HOOK_IDS, 'reconcile.require'),
      'reconcile.require must remain declared (additive/dormant wave_end gate)',
    );
    assert.deepEqual(MODULE_TO_HOOK_IDS['reconcile.require'], []);
  });
});
