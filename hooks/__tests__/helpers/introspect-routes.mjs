/**
 * Test helper — thin re-export wrapper around hooks/lib/route-introspection.mjs.
 *
 * Move #15: tests previously scraped hooks/hooks.json directly. After the
 * engine collapse (one entry per event pointing at mpl-engine.mjs), tests
 * import this helper to introspect the dispatch.mjs ROUTES registry instead.
 *
 * Production code (lib/mpl-hook-trace.mjs) imports the same helper directly
 * from lib/route-introspection.mjs — this file exists only so tests can use
 * a stable relative path without reaching into hooks/lib.
 */

export {
  MODULE_TO_HOOK_IDS,
  regexToMatcher,
  liveHooksFromRoutes,
  registeredRouteRows,
  lifecycleFor,
  allRegisteredHookIds,
} from '../../lib/route-introspection.mjs';
