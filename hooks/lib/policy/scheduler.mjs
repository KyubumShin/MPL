/**
 * MPL Scheduler (Move #16) — wave-scoped continuous-frontier dispatch loop.
 *
 * ============================================================================
 * STATUS — ADDITIVE / DORMANT
 * ============================================================================
 * This module ships the data model and pure-function dispatcher for a
 * wave-scoped continuous-frontier scheduler. Nothing wires it into a hook
 * route yet. The existing `/mpl run` flow continues to run through the
 * prompt-based scheduler in `commands/mpl-run-execute.md` Step 4.0. This
 * module activates only when a future move either:
 *
 *   (a) registers `wave_start` / `wave_end` routes in `lib/dispatch.mjs` that
 *       call `claim()` / `release()` from a real orchestrator runtime; or
 *   (b) rewrites `commands/mpl-run-execute.md` Step 4.0 to delegate to
 *       `dispatch_loop` here rather than the in-prompt while-loop.
 *
 * Until then, every exported function is a pure (or near-pure: claim/release
 * mutate the in-memory waveState passed in) helper that callers drive
 * explicitly. No top-level side effects.
 *
 * ============================================================================
 * SCOPE / DESIGN INVARIANTS (per Move #16 plan)
 * ============================================================================
 *  - SCHEDULER SCOPE: wave-level. One tier/wave at a time, mirroring the
 *    prompt scheduler in `commands/mpl-run-execute.md` Step 4.0.
 *  - WITHIN-WAVE BEHAVIOR: continuous-frontier — dispatch_loop pops any phase
 *    whose deps are closed AND whose claim is grantable, then routes it to
 *    a free slot. Never waits for the slowest peer to finish before starting
 *    the next pending phase.
 *  - SLOT SEMAPHORE: `max_phase_workers` (config.parallelism.max_phase_workers,
 *    clamped 1..3 — see hooks/lib/mpl-config.mjs:91-95).
 *  - DISPATCH OWNER: single-orchestrator. One engine process owns the claim
 *    ledger. Per-phase execution is multi-process via worktree slots
 *    (acquired through `lib/policy/isolation.mjs`).
 *  - TIER MUTEX: tiers with parallel:false get a virtual lock `tier_mutex_{N}`
 *    so concurrent claims within a non-parallel tier serialize.
 *  - HIGH-risk phases: REJECTED from parallel waves at compose time. They
 *    must run on the single-phase F-15 worktree_history path. The composer
 *    helper here (`validateWaveComposition`) raises a structured rejection
 *    and the wave is downgraded by the caller.
 *  - IMPACT DRIFT: post-execution check `detectImpactDrift` compares the
 *    declared impact.create/modify/affected_tests blast radius against the
 *    actual `git diff` set. Drift bubbles up as a non-fatal warning entry
 *    (the executor decides whether to escalate to a block).
 *
 * ExecutionContext shape (mirrors the Move #16 plan):
 *   {
 *     run_id: string,                 // state.started_at
 *     wave_id: string,                // `${tier}:${wave_index}`
 *     phase_id: string,               // decomposition.phases[].id
 *     slot_id: integer,               // [0, max_phase_workers)
 *     execution_context_id: string,   // UUID-ish, minted at claim time
 *     worktree_root: string,          // from isolation.acquireSlot
 *   }
 */

import { randomBytes } from 'crypto';
import { spawnSync } from 'child_process';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_PHASE_WORKERS_CEIL = 3;
const MAX_PHASE_WORKERS_FLOOR = 1;
const DEFAULT_MAX_PHASE_WORKERS = 2;

// Phase lifecycle vocabulary — additive to state.phase_lifecycle[].status.
// All terminal states release a slot and remove the running[] row.
export const PHASE_LIFECYCLE_STATES = Object.freeze({
  PENDING: 'PENDING',
  CLAIMED: 'CLAIMED',
  RUNNING: 'RUNNING',
  MERGING: 'MERGING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  ABANDONED: 'ABANDONED',
});

const TERMINAL_STATES = new Set([
  PHASE_LIFECYCLE_STATES.COMPLETED,
  PHASE_LIFECYCLE_STATES.FAILED,
  PHASE_LIFECYCLE_STATES.ABANDONED,
]);

// Canonical rejection codes — extend the prompt-scheduler vocabulary already
// listed in commands/mpl-run-execute.md (no_parallel_explanation classifier).
// Kept here so the Node scheduler emits identical codes when it eventually
// owns dispatch.
export const WAVE_REJECTION_CODES = Object.freeze({
  TIER_PARALLEL_FALSE: 'tier_parallel_false',
  SINGLE_READY_PHASE: 'single_ready_phase',
  HIGH_RISK_PHASE: 'high_risk_phase_rejected',
  FILE_OVERLAP: 'file_overlap',
  RESOURCE_LOCK: 'resource_lock',
  DEPENDENCY_FRONTIER: 'dependency_frontier',
  WAVE_EXECUTION_ERROR: 'wave_execution_error',
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function clampMaxPhaseWorkers(v) {
  if (!Number.isInteger(v)) return DEFAULT_MAX_PHASE_WORKERS;
  return Math.min(MAX_PHASE_WORKERS_CEIL, Math.max(MAX_PHASE_WORKERS_FLOOR, v));
}

/**
 * Mint a stable identifier for cross-boundary trace correlation
 * (hook → subagent → merge). Uses crypto.randomBytes for low collision
 * probability without pulling in a UUID dependency.
 */
export function mintExecutionContextId() {
  // 16 random bytes rendered as 32 hex chars — fits in any JSON envelope
  // and is short enough for log lines.
  return randomBytes(16).toString('hex');
}

/**
 * Read max_phase_workers from a v1- or v2-shaped config object.
 *
 * Both shapes carry `config.parallelism.max_phase_workers`. We re-clamp here
 * (defense in depth) because the dispatch loop is the one place where a
 * mis-tuned config would let an excessive worker count blow past the slot
 * pool budget.
 */
export function resolveMaxPhaseWorkers(config) {
  const p = isPlainObject(config?.parallelism) ? config.parallelism : {};
  return clampMaxPhaseWorkers(p.max_phase_workers);
}

// ---------------------------------------------------------------------------
// Wave composition
// ---------------------------------------------------------------------------

/**
 * Validate that a proposed wave can actually run in parallel.
 *
 * Inputs:
 *   wave: { tier, wave_index, phases: [{id, impact, risk_level, dependencies}] }
 *   options: {
 *     completed_phase_ids: string[],      // closed dep set
 *     reject_high_risk:    boolean,       // default true
 *   }
 *
 * Returns:
 *   { ok: true,  reasons: [] }                       — wave passes
 *   { ok: false, reasons: [{ phase_id, code, ... }] } — wave must be
 *                                                       downgraded by caller
 *
 * Caller is responsible for emitting the matching scheduler rejection event
 * — this function is pure; it does NOT mutate state. The composer mirrors
 * the prompt-scheduler conflict-free wave split in mpl-run-execute.md
 * Step 4.0 (file-overlap, dependency-frontier) but stays free of YAML
 * parsing so the input shape is decoupled from decomposition.yaml format
 * drift.
 */
export function validateWaveComposition(wave, options = {}) {
  const reasons = [];
  if (!wave || !Array.isArray(wave.phases)) {
    return {
      ok: false,
      reasons: [{ code: WAVE_REJECTION_CODES.WAVE_EXECUTION_ERROR, detail: 'wave.phases missing' }],
    };
  }

  const completed = new Set(options.completed_phase_ids || []);
  const rejectHigh = options.reject_high_risk !== false; // default true

  // Track per-path writer so we can spot overlaps in a single pass.
  const pathOwners = new Map();

  for (const phase of wave.phases) {
    if (!phase || typeof phase.id !== 'string') {
      reasons.push({ code: WAVE_REJECTION_CODES.WAVE_EXECUTION_ERROR, detail: 'phase entry missing id' });
      continue;
    }

    // HIGH-risk veto.
    if (rejectHigh && phase.risk_level === 'HIGH') {
      reasons.push({
        phase_id: phase.id,
        code: WAVE_REJECTION_CODES.HIGH_RISK_PHASE,
        detail: 'HIGH-risk phase must run via single-phase F-15 worktree_history path',
      });
    }

    // Dependency frontier closure.
    const deps = Array.isArray(phase.dependencies) ? phase.dependencies : [];
    for (const dep of deps) {
      if (typeof dep !== 'string') continue;
      if (!completed.has(dep)) {
        reasons.push({
          phase_id: phase.id,
          code: WAVE_REJECTION_CODES.DEPENDENCY_FRONTIER,
          detail: `unmet dependency ${dep}`,
        });
      }
    }

    // File-overlap detection on declared impact (create ∪ modify).
    const writes = [
      ...(Array.isArray(phase.impact?.create) ? phase.impact.create : []),
      ...(Array.isArray(phase.impact?.modify) ? phase.impact.modify : []),
    ];
    for (const path of writes) {
      if (typeof path !== 'string' || !path) continue;
      const owner = pathOwners.get(path);
      if (owner && owner !== phase.id) {
        reasons.push({
          phase_id: phase.id,
          code: WAVE_REJECTION_CODES.FILE_OVERLAP,
          detail: `path ${path} also claimed by ${owner}`,
        });
      } else {
        pathOwners.set(path, phase.id);
      }
    }
  }

  return reasons.length === 0
    ? { ok: true, reasons: [] }
    : { ok: false, reasons };
}

// ---------------------------------------------------------------------------
// Wave runtime state
// ---------------------------------------------------------------------------

/**
 * Build the in-memory wave runtime state seed. The caller passes this
 * object through claim/release/dispatch_loop. It is plain JSON so callers
 * can persist it into `state.waves_in_flight[]` between dispatcher ticks
 * without losing information.
 *
 * Shape:
 *   {
 *     run_id, tier, wave_index, wave_id,
 *     max_phase_workers, tier_parallel,
 *     slots:    [{ slot_id, phase_id|null, execution_context_id|null,
 *                  worktree_root|null, claimed_at|null }, ...],
 *     queue:    [phase_id, ...]                  // PENDING phases, FIFO
 *     running:  [executionContext, ...]          // active phases
 *     completed:[phase_id, ...]                  // terminated this wave
 *     failed:   [{ phase_id, reason }, ...]
 *     tier_mutex_held_by: phase_id | null        // parallel:false serializer
 *   }
 */
export function buildWaveState({ run_id, tier, wave_index, phase_ids, config, tier_parallel = true }) {
  const max = resolveMaxPhaseWorkers(config);
  const slots = [];
  for (let i = 0; i < max; i++) {
    slots.push({
      slot_id: i,
      phase_id: null,
      execution_context_id: null,
      worktree_root: null,
      claimed_at: null,
    });
  }
  return {
    run_id: String(run_id || ''),
    tier: Number(tier) || 0,
    wave_index: Number(wave_index) || 0,
    wave_id: `${tier}:${wave_index}`,
    max_phase_workers: max,
    tier_parallel: !!tier_parallel,
    slots,
    queue: Array.isArray(phase_ids) ? phase_ids.slice() : [],
    running: [],
    completed: [],
    failed: [],
    tier_mutex_held_by: null,
  };
}

// ---------------------------------------------------------------------------
// Claim / Release
// ---------------------------------------------------------------------------

/**
 * Claim a slot for `phase_id`. Returns the minted ExecutionContext, or
 * `null` if the claim is currently un-grantable (no free slot, or
 * tier_mutex held).
 *
 * Mutates `waveState` in place:
 *   - removes phase_id from `queue`
 *   - assigns the lowest-id free slot
 *   - mints an execution_context_id
 *   - pushes the ExecutionContext into `running`
 *
 * The worktree_root is NOT set here — the caller is expected to pair the
 * claim with `lib/policy/isolation.mjs#acquireSlot(...)` and rewrite the
 * returned context's `worktree_root` field. Two-step contract keeps this
 * module free of fs / git side effects.
 *
 * tier_mutex contract: when `waveState.tier_parallel === false`, only one
 * phase may hold a slot at a time. A second claim returns `null` until the
 * first releases — the dispatch loop will reattempt on the next tick.
 */
export function claim(waveState, phase_id, { worktree_root = null } = {}) {
  if (!waveState || typeof phase_id !== 'string') return null;

  // tier_mutex (virtual lock) — parallel:false tiers serialize.
  if (!waveState.tier_parallel && waveState.tier_mutex_held_by) {
    return null;
  }

  const free = waveState.slots.find((s) => s.phase_id === null);
  if (!free) return null;

  // Drop from queue if present.
  const qIdx = waveState.queue.indexOf(phase_id);
  if (qIdx >= 0) waveState.queue.splice(qIdx, 1);

  const execution_context_id = mintExecutionContextId();
  free.phase_id = phase_id;
  free.execution_context_id = execution_context_id;
  free.worktree_root = worktree_root;
  free.claimed_at = new Date().toISOString();

  if (!waveState.tier_parallel) {
    waveState.tier_mutex_held_by = phase_id;
  }

  const ctx = {
    run_id: waveState.run_id,
    wave_id: waveState.wave_id,
    phase_id,
    slot_id: free.slot_id,
    execution_context_id,
    worktree_root,
  };
  waveState.running.push(ctx);
  return ctx;
}

/**
 * Release a slot. `outcome` is one of PHASE_LIFECYCLE_STATES terminal
 * values (COMPLETED, FAILED, ABANDONED). Mutates waveState; returns the
 * removed ExecutionContext or null if not found.
 */
export function release(waveState, phase_id, { outcome = PHASE_LIFECYCLE_STATES.COMPLETED, reason = null } = {}) {
  if (!waveState || typeof phase_id !== 'string') return null;
  const idx = waveState.running.findIndex((c) => c.phase_id === phase_id);
  if (idx < 0) return null;

  const ctx = waveState.running.splice(idx, 1)[0];
  const slot = waveState.slots.find((s) => s.slot_id === ctx.slot_id);
  if (slot) {
    slot.phase_id = null;
    slot.execution_context_id = null;
    slot.worktree_root = null;
    slot.claimed_at = null;
  }
  if (waveState.tier_mutex_held_by === phase_id) {
    waveState.tier_mutex_held_by = null;
  }

  if (TERMINAL_STATES.has(outcome)) {
    if (outcome === PHASE_LIFECYCLE_STATES.COMPLETED) {
      waveState.completed.push(phase_id);
    } else {
      waveState.failed.push({ phase_id, reason: reason || outcome });
    }
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Dispatch loop
// ---------------------------------------------------------------------------

/**
 * Single dispatcher tick. Pops every phase whose deps are closed AND whose
 * claim is grantable, then routes them via `route_fn` to a fresh slot.
 *
 *   waveState        — built by buildWaveState
 *   options:
 *     ready_predicate(phase_id, waveState) → boolean — defaults to "all queued
 *                       phases are ready" (deps are pre-cleared by the
 *                       composer via validateWaveComposition).
 *     route_fn(ctx) → void|Promise<void>            — caller-supplied
 *                       runner. Synchronous OR async — `dispatch_loop` does
 *                       not await; it returns claimed contexts so the
 *                       caller can spawn workers however it wants
 *                       (worker_threads, child_process, Promise.all, etc).
 *     acquire_slot(ctx) → { worktree_root } | null  — optional. When
 *                       present, called after each successful claim so the
 *                       caller can wire `lib/policy/isolation.mjs#acquireSlot`
 *                       without this module taking on an fs dependency.
 *                       Return `null` to ABANDON the claim (released
 *                       immediately as ABANDONED).
 *
 * Returns the list of ExecutionContexts dispatched this tick. Empty list
 * means either every slot is busy, the queue is empty, or the
 * ready_predicate vetoed every queued phase.
 */
export function dispatch_loop(waveState, options = {}) {
  if (!waveState) return [];
  const ready = typeof options.ready_predicate === 'function'
    ? options.ready_predicate
    : () => true;
  const dispatched = [];

  // Snapshot the queue order before claim() mutates it.
  const queueSnapshot = waveState.queue.slice();

  for (const phase_id of queueSnapshot) {
    if (!ready(phase_id, waveState)) continue;
    const ctx = claim(waveState, phase_id);
    if (!ctx) break; // out of slots OR tier_mutex blocking — try next tick

    if (typeof options.acquire_slot === 'function') {
      let acquired;
      try {
        acquired = options.acquire_slot(ctx);
      } catch {
        acquired = null;
      }
      if (!acquired) {
        release(waveState, phase_id, {
          outcome: PHASE_LIFECYCLE_STATES.ABANDONED,
          reason: 'acquire_slot_failed',
        });
        continue;
      }
      const slot = waveState.slots.find((s) => s.slot_id === ctx.slot_id);
      if (slot) slot.worktree_root = acquired.worktree_root || null;
      ctx.worktree_root = acquired.worktree_root || null;
    }

    if (typeof options.route_fn === 'function') {
      try {
        // Fire-and-forget. The runner is expected to call back into release()
        // on completion. Errors are swallowed here — fail-open dispatch.
        options.route_fn(ctx);
      } catch {
        release(waveState, phase_id, {
          outcome: PHASE_LIFECYCLE_STATES.FAILED,
          reason: 'route_fn_threw',
        });
        continue;
      }
    }
    dispatched.push(ctx);
  }
  return dispatched;
}

// ---------------------------------------------------------------------------
// Impact drift detection
// ---------------------------------------------------------------------------

/**
 * Post-execution drift check. Given the phase's declared impact blast
 * radius and the observed git diff path list, returns the set of paths
 * that were written outside the declaration.
 *
 *   declared = { create: [...], modify: [...], affected_tests: [...] }
 *   observed = ['relative/path/a.ts', ...]   // typically from git diff --name-only
 *
 * Returns:
 *   { drift: boolean, undeclared: string[], missing_declared: string[] }
 *
 * `undeclared`        — paths in observed but not in any declared bucket.
 * `missing_declared`  — paths the phase claimed but never touched. The
 *                       caller decides whether missing-declared should be
 *                       fatal (typically: NO — declarations are forward
 *                       commitments, not after-the-fact assertions).
 *
 * Pure; no fs / process side effects.
 */
export function detectImpactDrift(declared = {}, observed = []) {
  const allDeclared = new Set([
    ...(Array.isArray(declared.create) ? declared.create : []),
    ...(Array.isArray(declared.modify) ? declared.modify : []),
    ...(Array.isArray(declared.affected_tests) ? declared.affected_tests : []),
  ]);
  const observedSet = new Set(Array.isArray(observed) ? observed : []);

  const undeclared = [];
  for (const p of observedSet) {
    if (!allDeclared.has(p)) undeclared.push(p);
  }
  const missing_declared = [];
  for (const p of allDeclared) {
    if (!observedSet.has(p)) missing_declared.push(p);
  }

  return {
    drift: undeclared.length > 0,
    undeclared: undeclared.sort(),
    missing_declared: missing_declared.sort(),
  };
}

/**
 * P2b — git-fed wave-end drift check.
 *
 * Runs `git diff --name-only <base_ref>..HEAD` inside `worktree_root`
 * and forwards the observed path list into the pure `detectImpactDrift`.
 * Lives next to the pure version so an `isolation → scheduler` reverse
 * import is unnecessary; the isolation CLI just calls this directly.
 *
 *   worktree_root: absolute path to a slot worktree
 *   base_ref:      git ref the slot was branched from. Callers MUST
 *                  thread a captured SHA (e.g. the value returned by
 *                  `acquireSlot`'s `acquired_base_sha`) — literal 'HEAD'
 *                  drifts as the workspace HEAD moves.
 *   declared:      `{ create, modify, affected_tests }` from phase_details
 *
 * Returns:
 *   { ok:true,  drift, undeclared, missing_declared, observed, error:null } |
 *   { ok:false, error, drift:false, undeclared:[], missing_declared:[], observed:[] }
 *
 * Never throws — git failures surface as `{ ok:false }` so the dispatcher
 * can route to ABANDONED without unwinding.
 */
export function detectImpactDriftFromGit(worktree_root, base_ref, declared) {
  if (typeof worktree_root !== 'string' || !worktree_root.startsWith('/')) {
    return { ok: false, error: 'worktree_root must be absolute', drift: false, undeclared: [], missing_declared: [], observed: [] };
  }
  if (typeof base_ref !== 'string' || !base_ref) {
    return { ok: false, error: 'base_ref required', drift: false, undeclared: [], missing_declared: [], observed: [] };
  }
  let r;
  try {
    r = spawnSync('git', ['diff', '--name-only', `${base_ref}..HEAD`], {
      cwd: worktree_root,
      encoding: 'utf-8',
      timeout: 30_000,
    });
  } catch (err) {
    return {
      ok: false,
      error: `git diff spawn failed: ${err?.message || err}`,
      drift: false, undeclared: [], missing_declared: [], observed: [],
    };
  }
  if (r.status !== 0) {
    return {
      ok: false,
      error: `git diff failed (exit ${r.status}): ${(r.stderr || '').trim()}`,
      drift: false, undeclared: [], missing_declared: [], observed: [],
    };
  }
  const observed = String(r.stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const pure = detectImpactDrift(declared, observed);
  return { ok: true, error: null, observed, ...pure };
}

// ---------------------------------------------------------------------------
// Persistence helpers (state.json shape — additive)
// ---------------------------------------------------------------------------

/**
 * Project a wave runtime into the persisted shapes documented in Move #16
 * Step 6 (additive state.json fields). The caller is expected to merge
 * these into state.json via lib/state/writer.mjs — this module does NOT
 * write to disk.
 *
 * Returns: {
 *   running:           ExecutionContext[],     // → state.running[]
 *   waves_in_flight:   { wave_id, tier, wave_index, slots, queue,
 *                        running, completed, failed }[]   // → state.waves_in_flight[]
 *   phase_lifecycle:   { [phase_id]: { status, slot_id?, execution_context_id?,
 *                                       worktree_root?, claimed_at?, terminated_at? } }
 * }
 */
export function projectStateRows(waveState, { phase_lifecycle_carry = {}, terminated_at = null } = {}) {
  const phase_lifecycle = { ...phase_lifecycle_carry };

  for (const ctx of waveState.running) {
    phase_lifecycle[ctx.phase_id] = {
      status: PHASE_LIFECYCLE_STATES.RUNNING,
      slot_id: ctx.slot_id,
      execution_context_id: ctx.execution_context_id,
      worktree_root: ctx.worktree_root,
      wave_id: waveState.wave_id,
    };
  }
  for (const pid of waveState.completed) {
    phase_lifecycle[pid] = {
      ...(phase_lifecycle[pid] || {}),
      status: PHASE_LIFECYCLE_STATES.COMPLETED,
      terminated_at: terminated_at || new Date().toISOString(),
      wave_id: waveState.wave_id,
    };
  }
  for (const { phase_id, reason } of waveState.failed) {
    phase_lifecycle[phase_id] = {
      ...(phase_lifecycle[phase_id] || {}),
      status: reason === 'acquire_slot_failed' || reason === PHASE_LIFECYCLE_STATES.ABANDONED
        ? PHASE_LIFECYCLE_STATES.ABANDONED
        : PHASE_LIFECYCLE_STATES.FAILED,
      reason,
      terminated_at: terminated_at || new Date().toISOString(),
      wave_id: waveState.wave_id,
    };
  }

  return {
    running: waveState.running.slice(),
    waves_in_flight: [{
      wave_id: waveState.wave_id,
      tier: waveState.tier,
      wave_index: waveState.wave_index,
      max_phase_workers: waveState.max_phase_workers,
      tier_parallel: waveState.tier_parallel,
      slots: waveState.slots.map((s) => ({ ...s })),
      queue: waveState.queue.slice(),
      running_phase_ids: waveState.running.map((c) => c.phase_id),
      completed: waveState.completed.slice(),
      failed: waveState.failed.slice(),
    }],
    phase_lifecycle,
  };
}

// ---------------------------------------------------------------------------
// route_to_phase — engine front-door resolver (called from mpl-engine.mjs)
// ---------------------------------------------------------------------------

/**
 * Resolve the active ExecutionContext for an incoming hook event. The
 * resolution chain (first match wins) is documented in the Move #16 plan:
 *
 *   (1) env.MPL_EXEC_CTX (JSON) + env.MPL_PHASE_ID
 *   (2) evt.cwd ⊆ a known worktree_root listed in state.running[]
 *   (3) tool_input.file_path lookup against decomposition.phases[].impact
 *       — match the phase that declared the path AND is currently in
 *       state.running[] (CLAIMED|RUNNING|MERGING)
 *   (4) state.current_phase fallback — single-phase legacy mode
 *
 * Fail-closed contract is enforced by the CALLER (mpl-engine.mjs):
 *   when state.running[].length > 0 AND resolution falls through to (4),
 *   the engine MAY deny non-read tools. This function never blocks — it
 *   returns the best-effort context (or null) and lets the caller decide.
 *
 * Fail-open contract here:
 *   any thrown error → null. The engine wraps this call in its own
 *   try/catch (per the plan) so a resolver crash never breaks the hook
 *   envelope.
 *
 * @param {object} args
 * @param {object} args.event   — parsed engine event ({ event, toolName, toolInput, cwd, raw })
 * @param {object|null} args.state — readState() output (or null)
 * @param {object} args.config  — loadConfig output (unused today; kept for
 *                                future decomposition lookups)
 * @param {object} args.env     — process.env snapshot
 * @returns {ExecutionContext|null}
 */
export function route_to_phase({ event, state, env } = {}) {
  // ---------- (1) Runner-threaded env vars ---------------------------------
  if (env && typeof env.MPL_EXEC_CTX === 'string' && env.MPL_EXEC_CTX) {
    try {
      const parsed = JSON.parse(env.MPL_EXEC_CTX);
      if (parsed && typeof parsed === 'object' && typeof parsed.phase_id === 'string') {
        return parsed;
      }
    } catch {
      // fall through to next resolver
    }
    // Fast-path: env.MPL_PHASE_ID alone is enough to anchor the route.
    if (typeof env.MPL_PHASE_ID === 'string' && env.MPL_PHASE_ID) {
      return {
        run_id: null,
        wave_id: null,
        phase_id: env.MPL_PHASE_ID,
        slot_id: null,
        execution_context_id: null,
        worktree_root: null,
      };
    }
  } else if (env && typeof env.MPL_PHASE_ID === 'string' && env.MPL_PHASE_ID) {
    return {
      run_id: null,
      wave_id: null,
      phase_id: env.MPL_PHASE_ID,
      slot_id: null,
      execution_context_id: null,
      worktree_root: null,
    };
  }

  const running = Array.isArray(state?.running) ? state.running : [];

  // ---------- (2) cwd ⊆ worktree_root --------------------------------------
  const cwd = typeof event?.cwd === 'string' ? event.cwd : '';
  if (cwd && running.length > 0) {
    // Longest-prefix match so a nested worktree wins over an ancestor.
    let best = null;
    let bestLen = -1;
    for (const ctx of running) {
      const root = typeof ctx?.worktree_root === 'string' ? ctx.worktree_root : '';
      if (!root) continue;
      if (cwd === root || cwd.startsWith(root.endsWith('/') ? root : root + '/')) {
        if (root.length > bestLen) {
          best = ctx;
          bestLen = root.length;
        }
      }
    }
    if (best) return best;
  }

  // ---------- (3) tool_input file_path → declared phase impact -------------
  const filePath = typeof event?.toolInput?.file_path === 'string'
    ? event.toolInput.file_path
    : '';
  if (filePath && running.length > 0) {
    // decomposition phases come from state.execution.phase_details[] (the
    // unified shape) when populated, otherwise we cannot resolve. The
    // matcher walks declared impact.create + impact.modify only — affected
    // tests are not write-authoritative.
    const phaseDefs = Array.isArray(state?.execution?.phase_details)
      ? state.execution.phase_details
      : [];
    const runningIds = new Set(running.map((c) => c.phase_id));
    for (const def of phaseDefs) {
      if (!def || typeof def.id !== 'string') continue;
      if (!runningIds.has(def.id)) continue;
      const writes = [
        ...(Array.isArray(def?.impact?.create) ? def.impact.create : []),
        ...(Array.isArray(def?.impact?.modify) ? def.impact.modify : []),
      ];
      if (writes.includes(filePath)) {
        return running.find((c) => c.phase_id === def.id) || null;
      }
    }
  }

  // ---------- (4) state.current_phase fallback -----------------------------
  if (state && typeof state.current_phase === 'string' && state.current_phase) {
    return {
      run_id: state.started_at || null,
      wave_id: null,
      phase_id: state.current_phase,
      slot_id: null,
      execution_context_id: null,
      worktree_root: null,
      _legacy: true,
    };
  }

  return null;
}
