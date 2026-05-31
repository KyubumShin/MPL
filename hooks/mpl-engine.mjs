#!/usr/bin/env node
/**
 * MPL v2 Engine — single-entry hook dispatcher (proposal §4.2).
 *
 * STATE AT THIS COMMIT (Move #14): ROUTES table populated; hooks.json NOT
 * repointed yet. The engine still works end-to-end via `node
 * hooks/mpl-engine.mjs` (smoke tests + ad-hoc invocation) but Claude Code
 * continues to call the per-hook .mjs wrappers in production. A follow-up
 * move will swap hooks.json to route the 6 events through this single entry.
 *
 * ROLLBACK contract:
 *   TIER 1 — `MPL_ENGINE_BYPASS=1` makes the engine an inert no-op
 *            (emits `{continue:true, suppressOutput:true}` and exits 0).
 *            Use when the engine is misbehaving but the policy modules
 *            themselves are sound.
 *   TIER 2 — Restore the pre-Move-#14 `hooks.json` from
 *            `hooks/hooks.json.legacy-backup` (created in the move that
 *            flips routing — NOT this move).
 *   TIER 3 — `MPL_DISABLE_MODULES=id1,id2,...` disables specific module
 *            ids inside lib/dispatch.mjs at registration time. See
 *            installRoutes() in lib/dispatch.mjs.
 *
 * Sequence (verbatim from §4.2):
 *   1. parseEvent(stdin)  — defensive snake/camel-case normalization
 *   2. loadConfig(cwd)    — resilient: {} on import failure
 *   3. readState(cwd)     — resilient: null on import failure
 *   4. isMplActive(cwd)   — short-circuit; per-module opt-out via
 *                           moduleSpec.requireMplActive=false
 *   5. dispatch(ctx)      — declarative routing scan (lib/dispatch.mjs)
 *   6. sequential exec    — first 'block' decision short-circuits
 *   7. aggregate          — picks Dialect A (Stop, SessionStart systemMessage)
 *                           or Dialect B (PreToolUse permissionDecision,
 *                           PostToolUse / UserPromptSubmit / SessionStart
 *                           additionalContext) per a constant table
 *   8. signal emit        — placeholder no-op until lib/observability/signals.mjs
 *   9. envelope + exit 0  — universal fail-open on any throw
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Resilient lib imports -------------------------------------------------
// Move #5 ships before Moves #6+; some lib paths referenced by §4.2 may not
// exist yet. Every import is wrapped so a missing dep degrades to a safe
// no-op rather than crashing the hook.

async function importOptional(relPath) {
  try {
    return await import(pathToFileURL(join(__dirname, relPath)).href);
  } catch {
    return null;
  }
}

const stdinMod = await importOptional('lib/stdin.mjs');
// Prefer the v2 config module (`lib/config.mjs` → `loadConfigV2`) that the
// proposal §4.2 names; fall back to the established v1 (`lib/mpl-config.mjs`
// → `loadConfig`) when the v2 module has not yet shipped. Either resolves to
// `{}` on failure — config wiring is resilient by design.
const configV2Mod = await importOptional('lib/config.mjs');
const configV1Mod = await importOptional('lib/mpl-config.mjs');
const stateMod = await importOptional('lib/state/reader.mjs');
const dispatchMod = await importOptional('lib/dispatch.mjs');
const signalsMod = await importOptional('lib/observability/signals.mjs'); // not yet present — null is fine
const envelopeBridgeMod = await importOptional('lib/policy/envelope-bridge.mjs');

// --- Step 1: parseEvent ----------------------------------------------------

async function parseEvent() {
  const readStdin = stdinMod?.readStdin;
  if (typeof readStdin !== 'function') return {};
  let raw;
  try {
    raw = await readStdin(5000);
  } catch {
    return {};
  }
  if (!raw) return {};
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!data || typeof data !== 'object') return {};
  return {
    event: data.hook_event_name || data.hookEventName || '',
    toolName: data.tool_name || data.toolName || '',
    toolInput: data.tool_input || data.toolInput || {},
    toolResponse: data.tool_response || data.toolResponse || undefined,
    cwd: data.cwd || data.directory || process.cwd(),
    raw: data,
  };
}

// --- Step 7: dialect picker ------------------------------------------------
// Dialect A = top-level `systemMessage` / `decision` envelope (legacy events).
// Dialect B = `hookSpecificOutput.{permissionDecision|additionalContext}`.
//
// Per Claude Code hook spec:
//   - PreToolUse                  -> Dialect B (permissionDecision: allow|deny|ask)
//   - PostToolUse                 -> Dialect B (additionalContext)
//   - UserPromptSubmit            -> Dialect B (additionalContext)
//   - SessionStart                -> Dialect B (additionalContext) + Dialect A (systemMessage)
//   - Stop / SubagentStop         -> Dialect A (decision: block/allow + reason)
//   - Notification                -> Dialect A (passthrough)
const DIALECT_TABLE = {
  PreToolUse: 'B',
  PostToolUse: 'B',
  UserPromptSubmit: 'B',
  SessionStart: 'AB',
  Stop: 'A',
  SubagentStop: 'A',
  Notification: 'A',
};

function dialectFor(event) {
  return DIALECT_TABLE[event] || 'B';
}

// --- Step 7: aggregate decisions -> envelope -------------------------------

function aggregate(event, decisions) {
  // No decisions = perfectly inert pass-through.
  if (!decisions || decisions.length === 0) {
    return { continue: true, suppressOutput: true };
  }

  // First 'block' wins — already enforced by the executor short-circuit,
  // but we re-detect it here so aggregate stays a pure function of its input.
  // Accept both `action` and legacy `decision` field (source-edit policy).
  const blocking = decisions.find((d) => d && (d.action === 'block' || d.decision === 'block'));
  const dialect = dialectFor(event);

  if (blocking) {
    if (dialect === 'A' || dialect === 'AB') {
      return {
        continue: false,
        decision: 'block',
        reason: blocking.reason || 'blocked by MPL policy',
      };
    }
    // Dialect B block envelope — PreToolUse uses permissionDecision deny.
    if (event === 'PreToolUse') {
      return {
        continue: false,
        hookSpecificOutput: {
          hookEventName: event,
          permissionDecision: 'deny',
          permissionDecisionReason: blocking.reason || 'blocked by MPL policy',
        },
      };
    }
    return {
      continue: false,
      decision: 'block',
      reason: blocking.reason || 'blocked by MPL policy',
    };
  }

  // No block: collect additionalContext / systemMessage from warn/noop/allow.
  const contextParts = decisions
    .map((d) => (d && typeof d.additionalContext === 'string') ? d.additionalContext.trim() : '')
    .filter(Boolean);
  const systemMsgs = decisions
    .map((d) => (d && typeof d.systemMessage === 'string') ? d.systemMessage.trim() : '')
    .filter(Boolean);
  const explicitAllow = decisions.find((d) => d && d.permissionDecision === 'allow');

  const envelope = { continue: true };

  if (dialect === 'A') {
    if (systemMsgs.length) envelope.systemMessage = systemMsgs.join('\n\n');
    if (!systemMsgs.length && !contextParts.length) envelope.suppressOutput = true;
    return envelope;
  }

  // Dialect B (or AB).
  const hso = { hookEventName: event };
  if (event === 'PreToolUse' && explicitAllow) {
    hso.permissionDecision = 'allow';
    if (explicitAllow.reason) hso.permissionDecisionReason = explicitAllow.reason;
  }
  if (contextParts.length) hso.additionalContext = contextParts.join('\n\n');

  const hasHsoPayload = hso.permissionDecision || hso.additionalContext;
  if (hasHsoPayload) envelope.hookSpecificOutput = hso;
  if (dialect === 'AB' && systemMsgs.length) envelope.systemMessage = systemMsgs.join('\n\n');
  if (!hasHsoPayload && !envelope.systemMessage) envelope.suppressOutput = true;
  return envelope;
}

// --- Step 8: signal emission placeholder -----------------------------------

async function emitSignal(payload) {
  try {
    if (signalsMod && typeof signalsMod.emit === 'function') {
      await signalsMod.emit(payload);
    }
  } catch {
    /* fail-open: signals never break the hook */
  }
}

// --- Universal fail-open exit ---------------------------------------------

function silent() {
  try {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  } catch {
    /* nothing */
  }
  process.exit(0);
}

// --- main ------------------------------------------------------------------

async function main() {
  // TIER 1 ROLLBACK: env kill-switch. When set, engine becomes a no-op
  // regardless of stdin content. Drains stdin first to avoid SIGPIPE on the
  // upstream Claude Code process, then emits the inert envelope.
  if (process.env.MPL_ENGINE_BYPASS === '1') {
    try {
      if (stdinMod?.readStdin) await stdinMod.readStdin(500);
    } catch { /* ignore */ }
    return silent();
  }

  // Step 1
  const evt = await parseEvent();
  if (!evt || !evt.event) return silent();

  // Step 2 — resilient. Prefer v2 (`loadConfigV2`) when present, fall back
  // to v1 (`loadConfig`). Either failure path → `{}`.
  let config = {};
  try {
    if (configV2Mod && typeof configV2Mod.loadConfigV2 === 'function') {
      config = configV2Mod.loadConfigV2(evt.cwd) || {};
    } else if (configV1Mod && typeof configV1Mod.loadConfig === 'function') {
      config = configV1Mod.loadConfig(evt.cwd) || {};
    }
  } catch {
    config = {};
  }

  // Step 3 — resilient
  let state = null;
  try {
    if (stateMod && typeof stateMod.readState === 'function') {
      state = stateMod.readState(evt.cwd) || null;
    }
  } catch {
    state = null;
  }

  // Step 4 — short-circuit gate. Per-module opt-out lives on the spec
  // (`requireMplActive: false`); dispatch() consumes `ctx.mplActive`.
  let mplActive = false;
  try {
    if (stateMod && typeof stateMod.isMplActive === 'function') {
      mplActive = !!stateMod.isMplActive(evt.cwd);
    }
  } catch {
    mplActive = false;
  }

  // Step 5 — dispatch. If lib/dispatch.mjs failed to import, the matched
  // list is empty and aggregate() emits the inert envelope.
  const ctx = {
    event: evt.event,
    toolName: evt.toolName,
    toolInput: evt.toolInput,
    toolResponse: evt.toolResponse,
    cwd: evt.cwd,
    state,
    config,
    mplActive,
    raw: evt.raw,
  };

  // Lazy install of the ROUTES table on first invocation. installRoutes()
  // is idempotent — subsequent calls (e.g. from a long-lived test runner)
  // are cheap no-ops because the registry is process-local.
  try {
    if (dispatchMod && typeof dispatchMod.installRoutes === 'function') {
      await dispatchMod.installRoutes();
    }
  } catch {
    /* fail-open: an install error degrades to an empty registry */
  }

  let modules = [];
  try {
    if (dispatchMod && typeof dispatchMod.dispatch === 'function') {
      modules = dispatchMod.dispatch(ctx) || [];
    }
  } catch {
    modules = [];
  }

  // Step 6 — sequential execution; first 'block' wins.
  //
  // Step 6.5 (new — Move #14 Part 2): envelope bridge. After each decision is
  // captured we mirror its envelope side-effects back into .mpl/state.json so
  // mpl-recover / mpl-state-invariant / RUNBOOK rows see the same blocked_hook
  // envelope they did when the per-hook wrappers were authoritative. Structured
  // sideEffects[] entries are dispatched verbatim (port of the legacy
  // mpl-write-guard switch); implicit action='block' / 'allow' / 'warn' values
  // are synthesized into recordBlockedHook / clearBlockedHook calls using the
  // route -> hookId SSOT table. Fail-open: every bridge call is best-effort.
  const decisions = [];
  for (const mod of modules) {
    let decision;
    try {
      decision = await mod.handler(ctx);
    } catch (err) {
      // Module crash = fail-open for that module; record a noop.
      decision = { action: 'noop', reason: `module ${mod.id} threw: ${err?.message || err}` };
    }
    if (!decision || typeof decision !== 'object') {
      decision = { action: 'noop' };
    }
    decisions.push(decision);

    // Step 6.5 — envelope bridge. Wrapped in try/catch so a bridge failure
    // never blocks the hook response (writes to state.json are best-effort
    // — the hook's continue/decision envelope remains authoritative).
    try {
      if (envelopeBridgeMod && typeof envelopeBridgeMod.applyEnvelopeForDecision === 'function') {
        envelopeBridgeMod.applyEnvelopeForDecision({
          cwd: evt.cwd,
          moduleId: mod.id,
          decision,
          state,
        });
      }
    } catch {
      /* fail-open per envelope-bridge contract */
    }

    // Normalize: source-edit and a few legacy-shaped policies return
    // `decision: 'block'` rather than `action: 'block'`. Treat both as the
    // short-circuit signal so the engine matches the per-hook wrapper.
    const actionCode = decision.action || decision.decision;
    if (actionCode === 'block') break;
  }

  // Step 7 — aggregate
  const envelope = aggregate(evt.event, decisions);

  // Step 8 — placeholder signal emission (no-op until signals.mjs lands).
  await emitSignal({
    event: evt.event,
    toolName: evt.toolName,
    modules: modules.map((m) => m.id),
    decisions: decisions.map((d) => d.action || d.decision || 'noop'),
  });

  // Step 9 — emit envelope and exit cleanly.
  try {
    console.log(JSON.stringify(envelope));
  } catch {
    return silent();
  }
  process.exit(0);
}

main().catch(() => silent());
