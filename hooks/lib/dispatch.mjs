/**
 * MPL v2 Dispatch Registry — declarative routing brain for mpl-engine.mjs.
 *
 * Stage A foundation move (proposal §4.2). At this commit the registry is
 * intentionally **empty** — no policy modules import this file yet. The eight
 * `policy/*.mjs` modules from §3.1 will register against this contract in
 * Moves #6+ and `hooks.json` will repoint to `mpl-engine.mjs` later.
 *
 * Contract (v2):
 *   moduleSpec = {
 *     id:                string             // unique, used for ordering ties + tests
 *     events:            string[]           // ['PreToolUse', 'PostToolUse', 'Stop', ...]
 *     tools?:            RegExp             // matches against ctx.toolName (hooks.json semantics)
 *     conditions?:       (ctx) => boolean   // optional predicate; thrown errors = no match
 *     order:             number             // ascending; stable sort by id on ties
 *     requireMplActive:  boolean            // when true, skipped if .mpl/state.json says inactive
 *     handler:           async (ctx) => decision
 *   }
 *
 *   decision = {
 *     action:                'allow' | 'block' | 'warn' | 'noop'
 *     reason?:               string
 *     additionalContext?:    string
 *     permissionDecision?:   'allow' | 'deny' | 'ask'   // PreToolUse only (Dialect B)
 *     systemMessage?:        string                     // SessionStart / Stop (Dialect A)
 *   }
 *
 *   ctx = { event, toolName, toolInput, toolResponse?, cwd, state, config, raw }
 *
 * Routing semantics (mirrors hooks.json matcher):
 *   - events.includes(ctx.event)        — required gate
 *   - tools (regex)                     — optional; tested against (ctx.toolName || '')
 *   - conditions(ctx)                   — optional; truthy required, throws treated as false
 *   - requireMplActive                  — engine pre-filters before calling dispatch when relevant;
 *                                         dispatch ALSO respects it as defense-in-depth via
 *                                         `ctx.mplActive` flag the engine populates
 *
 * Execution order: ascending `order`, ties broken by `id` (stable lexical) so
 * the resulting list is deterministic across runs.
 */

const MODULES = [];

/**
 * Register a module spec. Idempotent: a second register with the same `id`
 * replaces the prior entry (prevents accidental double-registration when a
 * module is imported twice via dynamic import + ESM cycle).
 *
 * @param {object} spec
 * @returns {object} the normalized spec (frozen)
 */
export function register(spec) {
  if (!spec || typeof spec !== 'object') {
    throw new TypeError('dispatch.register: spec must be an object');
  }
  if (typeof spec.id !== 'string' || !spec.id) {
    throw new TypeError('dispatch.register: spec.id (string) is required');
  }
  if (!Array.isArray(spec.events) || spec.events.length === 0) {
    throw new TypeError(`dispatch.register(${spec.id}): spec.events (non-empty string[]) is required`);
  }
  if (typeof spec.handler !== 'function') {
    throw new TypeError(`dispatch.register(${spec.id}): spec.handler (async function) is required`);
  }
  const normalized = Object.freeze({
    id: spec.id,
    events: [...spec.events],
    tools: spec.tools instanceof RegExp ? spec.tools : undefined,
    conditions: typeof spec.conditions === 'function' ? spec.conditions : undefined,
    order: Number.isFinite(spec.order) ? spec.order : 100,
    requireMplActive: spec.requireMplActive !== false, // default true (opt-out)
    handler: spec.handler,
  });
  const existing = MODULES.findIndex((m) => m.id === normalized.id);
  if (existing >= 0) {
    MODULES[existing] = normalized;
  } else {
    MODULES.push(normalized);
  }
  return normalized;
}

/**
 * Dispatch the routing scan. Pure / synchronous filter — handlers are NOT
 * invoked here; the engine drives the sequential execution loop.
 *
 * @param {object} ctx — { event, toolName, toolInput?, toolResponse?, cwd, state, config, mplActive? }
 * @returns {object[]} matched module specs in execution order
 */
export function dispatch(ctx) {
  if (!ctx || typeof ctx.event !== 'string') return [];
  const toolName = typeof ctx.toolName === 'string' ? ctx.toolName : '';
  const mplActive = ctx.mplActive === true;

  const matched = [];
  for (const mod of MODULES) {
    if (!mod.events.includes(ctx.event)) continue;
    if (mod.requireMplActive && !mplActive) continue;
    if (mod.tools && !mod.tools.test(toolName)) continue;
    if (mod.conditions) {
      let ok = false;
      try {
        ok = !!mod.conditions(ctx);
      } catch {
        ok = false;
      }
      if (!ok) continue;
    }
    matched.push(mod);
  }

  // Stable sort: ascending order, then ascending id for deterministic ties.
  matched.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
  return matched;
}

/**
 * Test/inspection helper — returns a shallow copy so callers cannot mutate
 * the internal registry by reference.
 */
export function getRegistry() {
  return MODULES.slice();
}

/**
 * Test isolation — clears the registry. Production code never calls this.
 */
export function clearRegistry() {
  MODULES.length = 0;
}
