/**
 * MPL v2 Dispatch Registry — declarative routing brain for mpl-engine.mjs.
 *
 * MOVE #14: ROUTES table is now populated (lazy registration on first
 * dispatch()), wiring all 10 policy/observability modules into the engine.
 * `hooks.json` is intentionally NOT modified in this move (see CONSERVATIVE
 * FALLBACK in the Move #14 plan): the engine is wired but Claude Code still
 * routes events to the per-hook .mjs wrappers. The engine therefore stays
 * dormant in production until a follow-up move flips hooks.json.
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
 *
 * Rollback contract — TIER 3 (per-module disable):
 *   Set `MPL_DISABLE_MODULES=id1,id2,...` to silently no-op registration of
 *   matching ids at dispatch time. Use when ONE module misbehaves and you
 *   don't want to bounce the whole engine. Combine with TIER 1
 *   (`MPL_ENGINE_BYPASS=1` in mpl-engine.mjs) for a full kill-switch.
 */

const MODULES = [];

// Lazy import cache — policy/observability modules are loaded ONCE on first
// dispatch() call (or first registerRoutes() call from tests). The engine's
// importOptional() resolves the URL but we want the ROUTES table inside this
// module so dispatch() callers (engine + tests) get the same registry view.
let _routesInstalled = false;

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dispatch_dir = dirname(fileURLToPath(import.meta.url));

async function _importPolicy(rel) {
  try {
    return await import(pathToFileURL(join(__dispatch_dir, rel)).href);
  } catch {
    return null;
  }
}

function _disabledSet() {
  const env = process.env.MPL_DISABLE_MODULES;
  if (!env || typeof env !== 'string') return new Set();
  return new Set(env.split(',').map((s) => s.trim()).filter(Boolean));
}

/**
 * Build the canonical ROUTES table that maps the 10 policy/observability
 * modules onto Claude Code hook events. Per the Move #14 plan, the order
 * numbers below are deliberately ascending to preserve the legacy
 * positional semantics of hooks.json (auto-permit before write-guard;
 * tool-tracker first in PostToolUse; permit-learner last).
 *
 * This function is idempotent — second call replaces existing entries by id.
 * It is invoked lazily from dispatch() so registering a module from a test
 * (via register()) does not race with the route installer.
 */
export async function installRoutes() {
  if (_routesInstalled) return getRegistry();

  const [
    sourceEditMod,
    permitMod,
    gatesMod,
    contractsMod,
    schemasMod,
    channelRegistryMod,
    signalsMod,
    trackersMod,
    sessionInitMod, // may be null — no policy module backing yet
  ] = await Promise.all([
    _importPolicy('policy/source-edit.mjs'),
    _importPolicy('policy/permit.mjs'),
    _importPolicy('policy/gates.mjs'),
    _importPolicy('policy/contracts.mjs'),
    _importPolicy('policy/schemas.mjs'),
    _importPolicy('policy/channel-registry.mjs'),
    _importPolicy('observability/signals.mjs'),
    _importPolicy('observability/trackers.mjs'),
    _importPolicy('policy/session-init.mjs'),
  ]);

  const disabled = _disabledSet();
  const reg = (spec) => {
    if (disabled.has(spec.id)) return; // TIER 3 rollback hook
    register(spec);
  };

  // -------- Permit family (auto-permit MUST run first in PreToolUse) ------
  if (permitMod?.handle) {
    reg({
      id: 'permit.auto-permit',
      events: ['PreToolUse'],
      // legacy mpl-auto-permit had NO matcher — gates ALL tools.
      order: 5,
      requireMplActive: false,
      handler: (ctx) => permitMod.handle('auto_permit', ctx),
    });
    reg({
      id: 'permit.bash-timeout',
      events: ['PreToolUse'],
      tools: /^Bash$/,
      order: 20,
      handler: (ctx) => permitMod.handle('bash_timeout', ctx),
    });
    reg({
      id: 'permit.permit-learner',
      events: ['PostToolUse'],
      // matcher-less in legacy; gates ALL tools.
      order: 900,
      requireMplActive: false,
      handler: (ctx) => permitMod.handle('permit_learner', ctx),
    });
    reg({
      id: 'permit.fallback-grep',
      events: ['PostToolUse'],
      tools: /^(Edit|Write|MultiEdit)$/,
      order: 30,
      handler: (ctx) => permitMod.handle('fallback_grep', ctx),
    });
  }

  // -------- Source edit (PreToolUse only, write-guard equivalent) ---------
  if (sourceEditMod?.handle) {
    reg({
      id: 'source-edit',
      events: ['PreToolUse'],
      tools: /^(Edit|Write|MultiEdit|NotebookEdit|Bash|Task|Agent)$/i,
      order: 10,
      handler: (ctx) =>
        sourceEditMod.handle({
          event: 'PreToolUse',
          toolName: ctx.toolName,
          toolInput: ctx.toolInput,
          cwd: ctx.cwd,
          state: ctx.state,
          data: ctx.raw,
          isMplActive: ctx.mplActive === true,
          callerTranscriptPath:
            ctx.raw?.transcript_path || ctx.raw?.transcriptPath,
        }),
    });
  }

  // -------- Gates ---------------------------------------------------------
  if (gatesMod?.handle) {
    reg({
      id: 'gates.finalize',
      events: ['PreToolUse'],
      tools: /^(Edit|Write|MultiEdit)$/,
      order: 40,
      conditions: (ctx) =>
        /\.mpl\/state\.json$/.test(String(ctx.toolInput?.file_path || '')),
      handler: (ctx) =>
        gatesMod.handle('finalize', {
          cwd: ctx.cwd,
          state: ctx.state,
          config: ctx.config,
          toolName: ctx.toolName,
          toolInput: ctx.toolInput,
          hookEvent: 'PreToolUse',
        }),
    });
    reg({
      id: 'gates.quality',
      events: ['PostToolUse'],
      tools: /^(Task|Agent)$/,
      order: 100,
      conditions: (ctx) =>
        ctx.toolInput?.subagent_type === 'mpl-adversarial-reviewer' ||
        ctx.toolInput?.subagentType === 'mpl-adversarial-reviewer',
      handler: (ctx) => gatesMod.handle('quality', ctx),
    });
    reg({
      id: 'gates.ambiguity',
      events: ['PreToolUse'],
      tools: /^(Task|Agent)$/,
      order: 200,
      conditions: (ctx) =>
        /mpl-decomposer/.test(
          String(ctx.toolInput?.subagent_type || ctx.toolInput?.subagentType || ''),
        ),
      handler: (ctx) => gatesMod.handle('ambiguity', ctx),
    });
    reg({
      id: 'gates.phase-transition',
      events: ['Stop'],
      order: 10,
      requireMplActive: false,
      handler: (ctx) => gatesMod.handle('phase_transition', ctx),
    });
  }

  // -------- Contracts (collapsed: ONE pre + ONE post entry) ---------------
  if (contractsMod?.handle) {
    reg({
      id: 'contracts.pre',
      events: ['PreToolUse'],
      tools: /^(Edit|Write|MultiEdit|Task|Agent)$/,
      order: 50,
      handler: (ctx) =>
        contractsMod.handle('PreToolUse', { ...ctx, hookEvent: 'PreToolUse' }),
    });
    reg({
      id: 'contracts.post',
      events: ['PostToolUse'],
      tools: /^(Edit|Write|MultiEdit|Task|Agent)$/,
      order: 50,
      handler: (ctx) =>
        contractsMod.handle('PostToolUse', { ...ctx, hookEvent: 'PostToolUse' }),
    });
  }

  // -------- Channel registry (direct hookups for baseline + schema) -------
  if (channelRegistryMod?.evaluateChannelWrite) {
    const channelHandler = (hookEvent) => async (ctx) => {
      const filePath = String(ctx.toolInput?.file_path || '');
      if (!filePath) return { action: 'noop' };
      const relPath = channelRegistryMod.workspaceRelative
        ? channelRegistryMod.workspaceRelative(ctx.cwd, filePath)
        : filePath;
      let r;
      try {
        r = channelRegistryMod.evaluateChannelWrite({
          cwd: ctx.cwd,
          state: ctx.state,
          cfg: ctx.config,
          relPath,
          oldText: ctx.toolInput?.old_string || '',
          newText:
            ctx.toolInput?.new_string ||
            ctx.toolInput?.content ||
            '',
          toolName: ctx.toolName,
          hookEvent,
        });
      } catch {
        return { action: 'noop' };
      }
      if (!r || typeof r !== 'object') return { action: 'noop' };
      const out = { action: r.action || 'noop' };
      if (r.reason) out.reason = r.reason;
      if (r.code) out.code = r.code;
      return out;
    };
    reg({
      id: 'channel-registry.pre',
      events: ['PreToolUse'],
      tools: /^(Edit|Write|MultiEdit)$/,
      order: 45,
      handler: channelHandler('PreToolUse'),
    });
    reg({
      id: 'channel-registry.post',
      events: ['PostToolUse'],
      tools: /^(Edit|Write|MultiEdit|mcp__.*__write.*)/,
      order: 45,
      handler: channelHandler('PostToolUse'),
    });
  }

  // -------- Schemas -------------------------------------------------------
  if (schemasMod?.handle) {
    reg({
      id: 'schemas.pivot-points',
      events: ['PreToolUse'],
      tools: /^(Write|Edit|MultiEdit)$/,
      order: 60,
      conditions: (ctx) =>
        /\.mpl\/pivot-points\.md$/.test(String(ctx.toolInput?.file_path || '')),
      handler: (ctx) => schemasMod.handle('pivot_points_schema', ctx),
    });
    reg({
      id: 'schemas.agent-output',
      events: ['PostToolUse'],
      tools: /^(Task|Agent)$/,
      order: 60,
      handler: (ctx) => schemasMod.handle('agent_output_schema', ctx),
    });
    reg({
      id: 'schemas.seed',
      events: ['PostToolUse'],
      tools: /^(Task|Agent|Write|Edit|MultiEdit)$/,
      order: 70,
      handler: (ctx) => schemasMod.handle('seed_schema', ctx),
    });
  }

  // -------- Observability: signals ---------------------------------------
  if (signalsMod?.handle) {
    reg({
      id: 'signals.s0',
      events: ['PostToolUse'],
      tools: /^(Task|Agent|Edit|Write|MultiEdit)$/,
      order: 500,
      handler: (ctx) => signalsMod.handle('s0', ctx),
    });
    reg({
      id: 'signals.s1',
      events: ['PostToolUse'],
      tools: /^(Task|Agent)$/,
      order: 510,
      handler: (ctx) => signalsMod.handle('s1', ctx),
    });
    reg({
      id: 'signals.s3',
      events: ['PostToolUse'],
      tools: /^(Task|Agent)$/,
      order: 520,
      handler: (ctx) => signalsMod.handle('s3', ctx),
    });
    reg({
      id: 'signals.pp-file',
      events: ['PostToolUse'],
      tools: /^(Edit|Write|MultiEdit)$/,
      order: 530,
      handler: (ctx) => signalsMod.handle('pp_file', ctx),
    });
    reg({
      id: 'signals.soft-signal-emit',
      events: ['PreToolUse'],
      tools: /^(Task|Agent)$/,
      order: 250,
      handler: (ctx) => signalsMod.handle('soft_signal_emit', ctx),
    });
    reg({
      id: 'signals.gate-recorder',
      events: ['PostToolUse'],
      tools: /^(Bash|Task|Agent)$/,
      order: 20,
      handler: (ctx) => signalsMod.handle('gate_recorder', ctx),
    });
    reg({
      id: 'signals.discovery-scanner',
      events: ['PostToolUse'],
      tools: /^(Task|Agent)$/,
      order: 540,
      conditions: (ctx) =>
        ctx.toolInput?.subagent_type === 'mpl-phase-runner' ||
        ctx.toolInput?.subagentType === 'mpl-phase-runner',
      handler: (ctx) => signalsMod.handle('discovery_scanner', ctx),
    });
    reg({
      id: 'signals.keyword-detector',
      events: ['UserPromptSubmit'],
      order: 10,
      requireMplActive: false,
      handler: (ctx) => signalsMod.handle('keyword_detector', ctx),
    });
  }

  // -------- Observability: trackers --------------------------------------
  if (trackersMod?.handle) {
    reg({
      id: 'trackers.tool-tracker',
      events: ['PostToolUse'],
      tools:
        /^(Bash|Edit|Write|MultiEdit|NotebookEdit|Task|Agent|Read|Grep|Glob|TodoWrite|WebFetch|WebSearch|SlashCommand|BashOutput|KillShell|ExitPlanMode|mcp__.*)/,
      order: 10,
      requireMplActive: false,
      handler: (ctx) => trackersMod.handle('tool_tracker', ctx),
    });
    reg({
      id: 'trackers.context-monitor',
      events: ['PostToolUse'],
      tools: /^(Task|Agent)$/,
      order: 600,
      handler: (ctx) => trackersMod.handle('context_monitor', ctx),
    });
    reg({
      id: 'trackers.compaction-tracker',
      events: ['PreCompact'],
      order: 10,
      requireMplActive: false,
      handler: (ctx) => trackersMod.handle('compaction_tracker', ctx),
    });
  }

  // -------- Session init --------------------------------------------------
  // policy/session-init.mjs does not yet exist (it remains as the thin
  // wrapper hook mpl-session-init.mjs). If a future move extracts the
  // body into policy/session-init.mjs with a `handle(ctx)` export, this
  // block will wire it automatically.
  if (sessionInitMod?.handle) {
    reg({
      id: 'session.init',
      events: ['SessionStart'],
      order: 10,
      requireMplActive: false,
      handler: (ctx) => sessionInitMod.handle(ctx),
    });
  }

  // -------- Reconciliation gate (Move #17) -------------------------------
  // Blocks dependent-phase frontier dispatch until the wave-end reconciler
  // produces a terminal outcome. Lives in the engine-front-door PreToolUse
  // chain at the same order tier as other "require-" gates (210 → after
  // ambiguity but before observability sinks). Additive / dormant until
  // wave_end routes ship.
  const reconcileMod = await _importPolicy('policy/reconcile/index.mjs');
  if (reconcileMod?.classifyWave) {
    reg({
      id: 'reconcile.require',
      events: ['PreToolUse'],
      tools: /^(Task|Agent)$/,
      order: 210,
      conditions: (ctx) => /mpl-phase-runner/.test(
        String(ctx.toolInput?.subagent_type || ctx.toolInput?.subagentType || ''),
      ),
      handler: async (ctx) => {
        // Read the wave-reconciliation.json sentinel; allow when absent
        // (no reconciliation in flight). When outcome is non-terminal,
        // block the dependent-phase dispatch.
        try {
          const { existsSync, readFileSync } = await import('fs');
          const { join: _join } = await import('path');
          const path = _join(ctx.cwd, '.mpl', 'signals', 'reconcile', 'wave-reconciliation.json');
          if (!existsSync(path)) return { action: 'noop' };
          let payload;
          try { payload = JSON.parse(readFileSync(path, 'utf-8')); } catch { return { action: 'noop' }; }
          const outcome = payload?.outcome;
          if (outcome === 'clean' || outcome === 'reconciled') return { action: 'allow' };
          if (outcome === 'pending_verifier') {
            return {
              action: 'block',
              reason: `wave ${payload?.wave_id} reconciliation pending verifier`,
              code: 'reconcile_pending',
            };
          }
          if (outcome === 'aborted') {
            return {
              action: 'block',
              reason: `wave ${payload?.wave_id} reconciliation aborted (${payload?.failure_code || 'unspecified'})`,
              code: payload?.failure_code || 'reconcile_aborted',
            };
          }
          return { action: 'noop' };
        } catch {
          return { action: 'noop' };
        }
      },
    });
  }

  _routesInstalled = true;
  return getRegistry();
}

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
 * Test isolation — clears the registry AND the lazy-install latch so a
 * subsequent installRoutes() call re-populates from scratch. Production
 * code never calls this.
 */
export function clearRegistry() {
  MODULES.length = 0;
  _routesInstalled = false;
}
