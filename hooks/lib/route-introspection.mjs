/**
 * MPL Route Introspection — single SSOT for "which hook ids the engine routes,
 * and what (event, matcher) they expose".
 *
 * Move #15: Stage-A's hooks.json was collapsed to a single entry point
 * (mpl-engine.mjs). Tests that previously scraped hooks.json for hook ids
 * + matchers (mpl-design-hooks-table, mpl-hook-trace, etc.) now read from
 * this helper, which expands the dispatch.mjs ROUTES registry into the
 * pre-collapse hook-id shape using a deterministic mapping.
 *
 * Why a separate file instead of inlining into dispatch.mjs:
 *   - dispatch.mjs's job is to register/route module specs at runtime.
 *   - The legacy hook-id table is a *documentation/introspection* surface:
 *     mpl-hook-trace renders it for operators, design.md mirrors it for
 *     reviewers. Keeping it here makes the dispatch logic clean and lets
 *     tests + lib/mpl-hook-trace.mjs share one source of truth.
 *
 * SSOT layering:
 *   1. dispatch.mjs ROUTES  — runtime registry (module specs + handlers).
 *   2. MODULE_TO_HOOK_IDS   — maps module.id -> legacy hook id(s) +
 *                             per-hook matcher overrides where the module
 *                             coalesces multiple legacy hooks.
 *   3. liveHooksFromRoutes  — produces the same Map<hookId, "Event: matcher; …">
 *                             shape the legacy hooks.json scrape produced.
 *   4. registeredRouteRows  — produces the row shape mpl-hook-trace needs.
 *   5. lifecycleFor         — single-hook lookup helper.
 */

import { installRoutes, getRegistry } from './dispatch.mjs';

// ----------------------------------------------------------------------------
// MODULE_TO_HOOK_IDS — maps each dispatch module id to one or more legacy
// hook ids, optionally overriding the route's `event` / `tools` regex.
//
// Shape: { [moduleId]: Array<{ hookId, event?, matcher? }> }
//   - When `event` is omitted, all events the module registers under apply.
//   - When `matcher` is omitted, the route's `tools` regex (converted to
//     pipe syntax) applies; an explicit string overrides it (used for the
//     contract sub-rules whose per-rule matcher is narrower than the
//     coalesced module matcher).
//
// Ground truth: hooks/hooks.json.legacy-backup (the pre-Move-#14 hooks.json).
// ----------------------------------------------------------------------------

export const MODULE_TO_HOOK_IDS = {
  // ── Permit family ────────────────────────────────────────────────────────
  'permit.auto-permit':       [{ hookId: 'mpl-auto-permit' }],
  'permit.bash-timeout':      [{ hookId: 'mpl-bash-timeout' }],
  'permit.permit-learner':    [{ hookId: 'mpl-permit-learner' }],
  'permit.fallback-grep':     [{ hookId: 'mpl-fallback-grep' }],

  // ── Source edit (write guard) ────────────────────────────────────────────
  // The dispatch route uses /^(Edit|Write|MultiEdit|NotebookEdit|Bash|Task|Agent)$/i
  // — keep that order for the matcher string.
  'source-edit':              [{ hookId: 'mpl-write-guard',
                                 matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|Task|Agent' }],

  // ── Gates ────────────────────────────────────────────────────────────────
  // mpl-finalize-gate coalesces the four legacy finalize hooks (#257). The
  // dispatch route fires on Edit|Write|MultiEdit for state.json writes;
  // mpl-finalize-gate is the public hook id that downstream consumers see.
  'gates.finalize':           [{ hookId: 'mpl-finalize-gate',
                                 matcher: 'Edit|Write|MultiEdit' }],
  'gates.quality':            [{ hookId: 'mpl-quality-gate',
                                 matcher: 'Task|Agent' }],
  'gates.ambiguity':          [{ hookId: 'mpl-ambiguity-gate',
                                 matcher: 'Task|Agent' }],
  'gates.phase-transition':   [{ hookId: 'mpl-phase-controller',
                                 event: 'Stop' }],

  // ── Contracts (coalesced PreToolUse + PostToolUse) ───────────────────────
  // The dispatch module fires on Edit|Write|MultiEdit|Task|Agent but each
  // sub-rule has its own narrower matcher visible in design.md.
  'contracts.pre': [
    // decomposition_write rules (Edit|Write|MultiEdit on decomposition.yaml)
    { hookId: 'mpl-require-covers',               matcher: 'Edit|Write|MultiEdit' },
    { hookId: 'mpl-require-goal-trace',           matcher: 'Edit|Write|MultiEdit' },
    { hookId: 'mpl-require-phase-contract-graph', matcher: 'Edit|Write|MultiEdit' },
    { hookId: 'mpl-require-decomposition-delta',  matcher: 'Edit|Write|MultiEdit' },
    // task_dispatch rules (Task|Agent)
    { hookId: 'mpl-require-chain-assignment',     matcher: 'Task|Agent' },
    { hookId: 'mpl-require-test-agent-brief',     matcher: 'Task|Agent' },
  ],
  'contracts.post': [
    { hookId: 'mpl-require-reviewer',             matcher: 'Edit|Write|MultiEdit' },
    { hookId: 'mpl-require-test-agent',           matcher: 'Task|Agent' },
  ],

  // ── Channel registry (collapsed pre/post) ────────────────────────────────
  // channel-registry.pre is the state-invariant entry point for
  // .mpl/state.json writes; pre-Move-#14 this was mpl-state-invariant on
  // PreToolUse: Task|Agent|Edit|Write|MultiEdit + Stop. We keep the
  // matcher exactly as design.md documents it.
  'channel-registry.pre':     [
    { hookId: 'mpl-state-invariant',
      matcher: 'Task|Agent|Edit|Write|MultiEdit' },
    // mpl-require-completed-phase-immutability + mpl-require-phase-evidence
    // + mpl-baseline-guard are also pre-Move-#14 state-write guards on the
    // same Edit|Write|MultiEdit matcher.
    { hookId: 'mpl-require-completed-phase-immutability',
      matcher: 'Edit|Write|MultiEdit' },
    { hookId: 'mpl-require-phase-evidence',
      matcher: 'Edit|Write|MultiEdit' },
    { hookId: 'mpl-baseline-guard',
      matcher: 'Edit|Write|MultiEdit' },
    // legacy mpl-validate-pp-schema also lives here as a PP-file guard.
    { hookId: 'mpl-validate-pp-schema',
      matcher: 'Edit|Write|MultiEdit' },
  ],
  'channel-registry.post':    [
    { hookId: 'mpl-artifact-schema',
      matcher: 'Edit|Write|MultiEdit|mcp__.*__write.*' },
    { hookId: 'mpl-decomposition-postprocess',
      matcher: 'Edit|Write|MultiEdit' },
  ],

  // ── Schemas ──────────────────────────────────────────────────────────────
  'schemas.pivot-points':     [], // folded into mpl-validate-pp-schema above
  'schemas.agent-output':     [{ hookId: 'mpl-validate-output',
                                 matcher: 'Task|Agent' }],
  'schemas.seed':             [{ hookId: 'mpl-validate-seed',
                                 matcher: 'Task|Agent|Write|Edit|MultiEdit' }],

  // ── Observability: signals ───────────────────────────────────────────────
  'signals.s0':               [{ hookId: 'mpl-sentinel-s0',
                                 matcher: 'Task|Agent|Write|Edit|MultiEdit' }],
  'signals.s1':               [{ hookId: 'mpl-sentinel-s1',
                                 matcher: 'Task|Agent' }],
  'signals.s3':               [{ hookId: 'mpl-sentinel-s3',
                                 matcher: 'Task|Agent' }],
  'signals.pp-file':          [{ hookId: 'mpl-sentinel-pp-file',
                                 matcher: 'Edit|Write|MultiEdit' }],
  'signals.soft-signal-emit': [{ hookId: 'mpl-soft-signal-emit',
                                 matcher: 'Task|Agent' }],
  'signals.gate-recorder':    [{ hookId: 'mpl-gate-recorder',
                                 matcher: 'Bash|Task|Agent' }],
  'signals.discovery-scanner':[{ hookId: 'mpl-discovery-scanner',
                                 matcher: 'Task|Agent' }],
  'signals.keyword-detector': [{ hookId: 'mpl-keyword-detector',
                                 event: 'UserPromptSubmit' }],

  // ── Observability: trackers ──────────────────────────────────────────────
  'trackers.tool-tracker':    [{ hookId: 'mpl-tool-tracker',
                                 matcher: 'Bash|Edit|Write|MultiEdit|Task|Agent|Read|Grep|Glob|TodoWrite|NotebookEdit|WebFetch|WebSearch|SlashCommand|BashOutput|KillShell|ExitPlanMode|mcp__.*' }],
  'trackers.context-monitor': [{ hookId: 'mpl-context-monitor',
                                 matcher: 'Task|Agent' }],
  'trackers.compaction-tracker': [{ hookId: 'mpl-compaction-tracker',
                                    event: 'PreCompact' }],

  // ── Session init ─────────────────────────────────────────────────────────
  'session.init':             [{ hookId: 'mpl-session-init',
                                 event: 'SessionStart' }],
};

// Stop-event entries that don't have a clean module surrogate in dispatch.mjs
// but are present in the legacy hooks.json: mpl-state-invariant also runs on
// Stop with no matcher, and mpl-phase-controller's Stop entry is registered
// via gates.phase-transition. Add the extra rows explicitly.
const EXTRA_LEGACY_ROWS = [
  { hookId: 'mpl-state-invariant', event: 'Stop',           matcher: '' },
];

// ----------------------------------------------------------------------------
// regexToMatcher — invert a route's `tools` RegExp back to a matcher string
// in the same pipe-delimited shape that hooks.json used (e.g. 'Edit|Write|MultiEdit').
// ----------------------------------------------------------------------------

/**
 * @param {RegExp|null|undefined} regex
 * @returns {string} pipe-delimited matcher string, or '' when no tools regex
 */
export function regexToMatcher(regex) {
  if (!regex) return '';
  const src = regex.source;
  // Strip leading ^ and trailing $ + surrounding parens — the dispatch
  // routes follow the convention /^(A|B|C)$/ or /^(...)/.
  let body = src;
  body = body.replace(/^\^/, '');
  body = body.replace(/\$$/, '');
  // Strip one pair of outer parens, if present.
  if (body.startsWith('(') && body.endsWith(')')) {
    body = body.slice(1, -1);
  }
  return body;
}

// ----------------------------------------------------------------------------
// _expandRoute — given a single dispatch route spec, yield zero or more
// (event, matcher, hookId) rows by looking up MODULE_TO_HOOK_IDS.
// ----------------------------------------------------------------------------

function _expandRoute(spec) {
  const entries = MODULE_TO_HOOK_IDS[spec.id];
  if (!entries || entries.length === 0) return [];
  const out = [];
  const routeMatcher = regexToMatcher(spec.tools);
  for (const entry of entries) {
    const events = entry.event ? [entry.event] : spec.events;
    const matcher = entry.matcher !== undefined ? entry.matcher : routeMatcher;
    for (const event of events) {
      out.push({ event, matcher, hookId: entry.hookId });
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// liveHooksFromRoutes — drop-in replacement for the legacy hooks.json scrape.
//
// Returns Map<hookId, "Event: matcher; Event2: matcher2; …"> alphabetically
// sorted by hookId. Same shape mpl-design-hooks-table.test.mjs::liveHooks()
// produced.
// ----------------------------------------------------------------------------

function formatEventMatcher(event, matcher) {
  return matcher ? `${event}: ${matcher.replaceAll('|', '/')}` : event;
}

export async function liveHooksFromRoutes() {
  await installRoutes();
  const routes = getRegistry();
  const hooks = new Map();

  for (const spec of routes) {
    for (const row of _expandRoute(spec)) {
      const entry = formatEventMatcher(row.event, row.matcher);
      const existing = hooks.get(row.hookId);
      hooks.set(row.hookId, existing ? `${existing}; ${entry}` : entry);
    }
  }
  // Append the EXTRA_LEGACY_ROWS (Stop-event mpl-state-invariant etc.).
  for (const row of EXTRA_LEGACY_ROWS) {
    const entry = formatEventMatcher(row.event, row.matcher);
    const existing = hooks.get(row.hookId);
    hooks.set(row.hookId, existing ? `${existing}; ${entry}` : entry);
  }
  return new Map([...hooks.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

// ----------------------------------------------------------------------------
// registeredRouteRows — produces the row shape mpl-hook-trace.mjs needs.
//
// Each row matches the legacy hooks.json iteration shape:
//   { event, matcher, hookId, command, timeout }
//
// `command` and `timeout` are set to legacy-equivalent values so downstream
// formatters keep working. `command` reconstructs the path to the wrapper
// .mjs (which still exists post-Move-#14); `timeout` defaults to null (the
// Move-#14 hooks.json no longer carries per-hook timeouts).
// ----------------------------------------------------------------------------

const HOOKS_ROOT = '${CLAUDE_PLUGIN_ROOT}/hooks';

function _commandFor(hookId) {
  return `node "${HOOKS_ROOT}/${hookId}.mjs"`;
}

export async function registeredRouteRows() {
  await installRoutes();
  const routes = getRegistry();
  const rows = [];
  for (const spec of routes) {
    for (const row of _expandRoute(spec)) {
      rows.push({
        event:    row.event,
        matcher:  row.matcher || null,
        hookId:   row.hookId,
        command:  _commandFor(row.hookId),
        timeout:  null,
      });
    }
  }
  for (const row of EXTRA_LEGACY_ROWS) {
    rows.push({
      event:    row.event,
      matcher:  row.matcher || null,
      hookId:   row.hookId,
      command:  _commandFor(row.hookId),
      timeout:  null,
    });
  }
  return rows;
}

// ----------------------------------------------------------------------------
// lifecycleFor — single-hook lookup. Returns the list of (event, matcher)
// entries the given hook id participates in. Empty array when not registered.
// ----------------------------------------------------------------------------

export async function lifecycleFor(hookId) {
  const rows = await registeredRouteRows();
  return rows
    .filter((r) => r.hookId === hookId)
    .map((r) => ({ event: r.event, matcher: r.matcher || '' }));
}

// ----------------------------------------------------------------------------
// allRegisteredHookIds — convenience: sorted, deduplicated hook id list.
// ----------------------------------------------------------------------------

export async function allRegisteredHookIds() {
  const rows = await registeredRouteRows();
  return [...new Set(rows.map((r) => r.hookId))].sort();
}
