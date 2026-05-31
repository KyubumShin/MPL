/**
 * MPL Audit Policy (L2 module — Move #13)
 *
 * SSOT for the F6 Tier 4 finalize-time audit, formerly
 * `hooks/lib/mpl-codex-audit.mjs`. Owns FOUR audit surfaces (was 3+drift):
 *
 *   1. anti_pattern_residual — re-scan files declared in decomposition.yaml
 *      (create + modify) using the F3 anti-pattern registry. Tier 1+2+3
 *      caught most at write-time; this surface lists what survived.
 *
 *   2. missing_covers — every `included` UC in user-contract.md must be
 *      covered by at least one phase. Phases that claim `covers: [UC-N]`
 *      must reference UCs that actually exist as included.
 *
 *   3. dangling_covers — phase claims `covers: [UC-N]` but UC-N is not
 *      included (typo, deferred-status drift, or stale decomposition).
 *      Co-emitted with missing_covers (single pure-fn pass).
 *
 *   4. drift — declared phase impact (create + modify paths) vs git
 *      changed files. `undeclared` are files touched but not in any
 *      phase scope; `unimplemented` are declared paths with no diff
 *      footprint. drift_unimplemented stays informational per F6's
 *      original contract; drift_undeclared is GATING by default.
 *
 *   5. manifest_drift (NEW) — phases in decomposition.yaml whose id is
 *      absent from state.completed_phases AND not the current_phase
 *      (finalize-time decomposition-vs-execution consistency check).
 *
 * Verdict policy — DECLARATIVE (Move #13 inversion of the eval finding):
 *   Driven by `config.audit.verdict.required_clean[]`. Each entry names
 *   a summary category that MUST be zero for PASS. Default list:
 *     ['anti_pattern_residual', 'missing_covers', 'dangling_covers',
 *      'drift_undeclared', 'manifest_drift']
 *   — closes the eval gap by gating on drift_undeclared and on the new
 *   manifest_drift surface. Forward-compat: future categories added to
 *   summary auto-gate by listing them here.
 *
 *   `config.audit.drift.escalate_undeclared_to_anti_pattern` (default TRUE)
 *   — when on, each drift_undeclared entry is injected into
 *   surfaces.anti_pattern_residual with synthetic id 'F6.drift_undeclared',
 *   severity 'warn', so downstream Tier 3+4 sinks see drift uniformly.
 *
 *   `enforcement.audit_residual` tri-state (warn|block|off) continues to
 *   gate the CLI exit code as before — pure policy returns the verdict
 *   only; the wrapper translates `block` + `fail` → exit 1.
 *
 * Public API:
 *   handle(event, ctx)             -> dispatcher
 *   handleAudit(ctx)               -> per-phase noop (Move #13 scaffolding;
 *                                     placeholder for phase-boundary residual
 *                                     sweeps in a follow-up Move)
 *   handleFinalizeAudit(ctx)       -> Tier 4 envelope with sideEffects
 *                                     (audit_report_write + audit_exit_code)
 *
 * Re-exported pure parsers (so existing test imports stay stable):
 *   parseDecompositionPhases, enumerateIncludedUserCases,
 *   findMissingCovers, findScopeDrift, auditAntiPatternResidual,
 *   isLegacyContractMode, findManifestDrift (new), runCodexAudit
 *
 * Dependency boundary (per hooks/lib/policy/README.md):
 *   - L1 helpers ONLY — mpl-config, mpl-enforcement, mpl-state,
 *     anti-pattern-registry, mpl-completed-phase-immutability.
 *   - NEVER imports another policy/*.mjs (leaf node).
 */

import { readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

import { loadRegistry, scanContent, isInScope } from '../anti-pattern-registry.mjs';
import { loadConfig } from '../mpl-config.mjs';
import { resolveRuleAction } from '../mpl-enforcement.mjs';
import { isMplActive } from '../mpl-state.mjs';
import { completedPhaseIds } from '../mpl-completed-phase-immutability.mjs';

// ============================================================================
// Shared constants
// ============================================================================

export const AUDIT_HOOK_ID = 'mpl-codex-audit';
export const AUDIT_REPORT_PATH = '.mpl/mpl/audit-report.json';

/**
 * Default required_clean list. Each name MUST match a key in the report
 * `summary` object — see runCodexAudit return shape.
 *
 * Move #13 inverts the legacy 3-conjunct expression (which gated only on
 * anti_pattern_residual + missing_covers + dangling_covers, letting drift
 * and decomposition manifest mismatch pass silently). The new default
 * gates on five categories; workspaces can opt out by overriding the
 * `audit.verdict.required_clean` array in mpl.config.yaml or .mpl/config.json.
 */
export const DEFAULT_REQUIRED_CLEAN = Object.freeze([
  'anti_pattern_residual',
  'missing_covers',
  'dangling_covers',
  'drift_undeclared',
  'manifest_drift',
]);

/**
 * Legacy required_clean list (pre-Move #13). Used when `runCodexAudit` is
 * called with `opts.legacyVerdict === true` to preserve the original
 * verdict expression for emergency rollback / dedicated regression test.
 */
export const LEGACY_REQUIRED_CLEAN = Object.freeze([
  'anti_pattern_residual',
  'missing_covers',
  'dangling_covers',
]);

// ============================================================================
// User contract parsing — verbatim move from lib/mpl-codex-audit.mjs
// ============================================================================

/**
 * Legacy graceful-skip mode signal. Mirrors `mpl-require-covers.mjs#isLegacyMode`
 * verbatim — file absence is the canonical signal that the project predates
 * 0.16 Tier B and never produced a UC contract.
 */
export function isLegacyContractMode(cwd) {
  return !existsSync(join(cwd, '.mpl/requirements/user-contract.md'));
}

export function enumerateIncludedUserCases(cwd) {
  const path = join(cwd, '.mpl/requirements/user-contract.md');
  if (!existsSync(path)) return [];

  let content;
  try { content = readFileSync(path, 'utf-8'); }
  catch { return []; }

  const lines = content.split('\n');
  const startIdx = lines.findIndex(l => /^\s*user_cases\s*:/.test(l));
  if (startIdx < 0) return [];

  const sectionIndent = (lines[startIdx].match(/^(\s*)/) ?? ['', ''])[1].length;

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    const indentMatch = line.match(/^(\s*)([a-z_]+)\s*:\s*$/);
    if (indentMatch && indentMatch[1].length === sectionIndent) {
      endIdx = i; break;
    }
    if (/^\s*```/.test(line)) { endIdx = i; break; }
  }
  const userCasesBlock = lines.slice(startIdx, endIdx).join('\n');

  const cases = [];
  const ucBlocks = userCasesBlock.split(/^\s*-\s+id\s*:\s*/m).slice(1);
  for (const block of ucBlocks) {
    const idMatch = block.match(/^["']?(UC-[\w-]+)["']?/);
    if (!idMatch) continue;
    const id = idMatch[1];

    const titleMatch = block.match(/^\s*title\s*:\s*["']?([^"'\n]+)["']?/m);
    const statusMatch = block.match(/^\s*status\s*:\s*["']?([\w-]+)["']?/m);
    const status = statusMatch ? statusMatch[1] : 'included';
    if (status !== 'included') continue;

    cases.push({
      id,
      title: titleMatch ? titleMatch[1].trim() : '',
    });
  }

  return cases;
}

// ============================================================================
// Decomposition parsing — verbatim move from lib/mpl-codex-audit.mjs
// ============================================================================

export function parseDecompositionPhases(cwd) {
  const path = join(cwd, '.mpl/mpl/decomposition.yaml');
  if (!existsSync(path)) return [];

  let content;
  try { content = readFileSync(path, 'utf-8'); }
  catch { return []; }

  const phases = [];
  const blocks = content.split(/^\s*-\s+id\s*:\s*/m).slice(1);

  for (const block of blocks) {
    const lines = block.split('\n');
    const id = lines[0]?.replace(/["']/g, '').trim();
    if (!id) continue;

    const covers = parseCoversArray(block);
    const impact = parseImpactFiles(block);

    phases.push({ id, covers, impact_files: impact });
  }

  return phases;
}

function parseCoversArray(block) {
  const inline = block.match(/^\s*covers\s*:\s*\[([^\]]*)\]/m);
  if (inline) {
    return inline[1]
      .split(',')
      .map(s => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }

  const out = [];
  const lines = block.split('\n');
  let inCovers = false;
  for (const line of lines) {
    if (/^\s*covers\s*:\s*$/.test(line)) { inCovers = true; continue; }
    if (!inCovers) continue;
    const item = line.match(/^\s*-\s*["']?([\w-]+)["']?\s*$/);
    if (item) { out.push(item[1]); continue; }
    if (/^\s*[a-z_]+\s*:/.test(line)) break;
  }
  return out;
}

function parseImpactFiles(block) {
  const lines = block.split('\n');
  const files = new Set();
  let activeSection = null;
  let sectionIndent = -1;
  for (const line of lines) {
    const sectionMatch = line.match(/^(\s+)(create|modify|affected_tests|affected_config)\s*:\s*$/);
    if (sectionMatch) {
      const isImpactKey = (sectionMatch[2] === 'create' || sectionMatch[2] === 'modify');
      activeSection = isImpactKey ? sectionMatch[2] : null;
      sectionIndent = sectionMatch[1].length;
      continue;
    }
    if (!activeSection) continue;
    const siblingMatch = line.match(/^(\s+)[a-z_]+\s*:\s*$/);
    if (siblingMatch && siblingMatch[1].length === sectionIndent) {
      activeSection = null;
      sectionIndent = -1;
      continue;
    }
    const pathInline = line.match(/^\s+-\s+path\s*:\s*["']?([^"'\n]+)["']?/);
    if (pathInline) { files.add(pathInline[1].trim()); continue; }
    const pathBare = line.match(/^\s+-\s+["']?([^"'\n#]+\.[\w]+)["']?\s*$/);
    if (pathBare) { files.add(pathBare[1].trim()); continue; }
  }
  return [...files];
}

// ============================================================================
// Surface 1: anti-pattern residual — verbatim move
// ============================================================================

export function auditAntiPatternResidual(cwd, pluginRoot, phases) {
  const registryPath = join(pluginRoot, 'commands', 'references', 'anti-patterns.md');
  if (!existsSync(registryPath)) return [];

  let registry;
  try { registry = loadRegistry(registryPath); }
  catch { return []; }

  const hits = [];
  const seen = new Set();
  for (const phase of phases) {
    for (const rel of phase.impact_files) {
      const key = `${phase.id} ${rel}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (!isInScope(rel, registry.scope)) continue;

      const abs = join(cwd, rel);
      if (!existsSync(abs)) continue;
      try {
        const stat = statSync(abs);
        if (!stat.isFile()) continue;
      } catch { continue; }

      let content;
      try { content = readFileSync(abs, 'utf-8'); }
      catch { continue; }

      const fileHits = scanContent(content, registry.patterns);
      for (const h of fileHits) {
        hits.push({
          phase_id: phase.id,
          file: rel,
          id: h.id,
          severity: h.severity,
          line: h.line,
          snippet: h.snippet,
        });
      }
    }
  }
  return hits;
}

// ============================================================================
// Surface 2: missing covers / dangling — verbatim move
// ============================================================================

export function findMissingCovers(includedUCs, phases, opts = {}) {
  if (opts.legacy === true) {
    return { uncovered: [], dangling: [] };
  }

  const includedIds = new Set(includedUCs.map(uc => uc.id));

  const claimed = new Set();
  const dangling = [];
  for (const phase of phases) {
    for (const c of phase.covers) {
      if (c === 'internal') continue;
      claimed.add(c);
      if (!includedIds.has(c)) {
        dangling.push({ phase_id: phase.id, uc_id: c, reason: 'phase claims UC not in included user_cases' });
      }
    }
  }

  const uncovered = [];
  for (const uc of includedUCs) {
    if (!claimed.has(uc.id)) {
      uncovered.push({ uc_id: uc.id, title: uc.title, reason: 'no phase covers this included UC' });
    }
  }

  return { uncovered, dangling };
}

// ============================================================================
// Surface 3: scope drift — verbatim move
// ============================================================================

export function findScopeDrift(cwd, phases, opts = {}) {
  const declared = new Set();
  for (const phase of phases) {
    for (const f of phase.impact_files) declared.add(f);
  }

  const actual = collectActualChanges(cwd, opts);
  if (actual === null) {
    return { undeclared: [], unimplemented: [], git_unavailable: true };
  }

  const filtered = actual.filter(f => !/(^|\/)__tests__\//.test(f) && !/\.test\./.test(f));

  const undeclared = filtered.filter(f => !declared.has(f));
  const unimplemented = [...declared].filter(f => !actual.includes(f));

  return { undeclared, unimplemented };
}

function collectActualChanges(cwd, opts = {}) {
  const probes = opts.probes ?? [
    '{ git diff --name-only HEAD 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null; }',
    'git diff --name-only --cached 2>/dev/null',
    'git diff --name-only $(git merge-base HEAD $(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/main) 2>/dev/null || echo HEAD~20)..HEAD 2>/dev/null',
    'git diff --name-only HEAD~20..HEAD 2>/dev/null',
  ];
  for (const cmd of probes) {
    try {
      const out = execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' });
      const files = out.split('\n').map(l => l.trim()).filter(Boolean);
      if (files.length > 0) return files;
    } catch { /* try next */ }
  }
  try {
    execSync('git rev-parse --git-dir', { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    return [];
  } catch {
    return null;
  }
}

// ============================================================================
// Surface 4 (NEW, Move #13): manifest drift
// ============================================================================

/**
 * Cross-check decomposition phase ids against the execution manifest
 * (state.completed_phases / state.execution.phase_details + current_phase).
 *
 * A phase id declared in decomposition.yaml but ABSENT from the completed
 * set AND not the current_phase is a `manifest_drift` finding — the
 * decomposition believes the phase exists but execution never recorded
 * it (forgotten phase, mid-pipeline rename mismatch, or stale doc).
 *
 * This is finalize-time only — interim execution may legitimately be
 * mid-phase, but at finalize the union of completed + current SHOULD
 * cover every decomposed phase.
 *
 * @param {object|null|undefined} state - pipeline state.json (or null)
 * @param {Array<{id:string}>} phases - parseDecompositionPhases output
 * @param {string} [cwd] - workspace root, only used when state lacks completed
 *                         (delegates to completedPhaseIds disk fallback)
 * @returns {Array<{phase_id:string, reason:string}>}
 */
export function findManifestDrift(state, phases, cwd) {
  // No execution context (no state.json on disk, no in-memory state
  // passed) → we cannot make a finalize-time decomposition-vs-execution
  // determination. Return empty rather than flagging every declared phase
  // — that would punish synthetic workspaces (smoke tests, fresh repos
  // being audited before any phase ran) for a condition they cannot
  // satisfy. This mirrors the legacy_skip semantics for missing_covers.
  //
  // Heuristic: state is considered "absent" when it is null/undefined OR
  // it has neither completed_phases nor execution.phase_details nor
  // current_phase populated. Workspaces that have actually executed
  // phases will surface at least one of these.
  if (!hasExecutionContext(state, cwd)) return [];

  // Build canonical completed-id set: prefer the L1 helper (state +
  // disk merge), fall back to the literal `state.completed_phases` array
  // if a caller hands us a synthetic state shape (the plan names this
  // field directly so we honor either spelling).
  const completedFromHelper = (typeof cwd === 'string')
    ? completedPhaseIds(cwd, state || {})
    : ((state?.execution?.phase_details || [])
        .filter((d) => d?.id && d.status === 'completed')
        .map((d) => d.id));
  const completedDirect = Array.isArray(state?.completed_phases)
    ? state.completed_phases.map((entry) => (typeof entry === 'string' ? entry : entry?.id)).filter(Boolean)
    : [];
  const completed = new Set([...completedFromHelper, ...completedDirect]);

  const currentPhase = state?.current_phase ?? state?.execution?.phases?.current ?? null;

  const drift = [];
  for (const phase of phases) {
    if (!phase?.id) continue;
    if (completed.has(phase.id)) continue;
    if (currentPhase && phase.id === currentPhase) continue;
    drift.push({
      phase_id: phase.id,
      reason: 'phase declared in decomposition.yaml but absent from state.completed_phases (and not current_phase)',
    });
  }
  return drift;
}

function hasExecutionContext(state, cwd) {
  if (state && typeof state === 'object') {
    if (Array.isArray(state.completed_phases) && state.completed_phases.length > 0) return true;
    if (Array.isArray(state?.execution?.phase_details) && state.execution.phase_details.length > 0) return true;
    if (typeof state.current_phase === 'string' && state.current_phase) return true;
    if (typeof state?.execution?.phases?.current === 'string') return true;
  }
  // No usable state object — fall back to disk presence of state.json so
  // a wrapper that didn't preload state but the workspace has it on disk
  // still surfaces manifest_drift.
  if (typeof cwd === 'string') {
    try {
      const p = join(cwd, '.mpl', 'state.json');
      if (existsSync(p)) return true;
    } catch { /* fall through */ }
  }
  return false;
}

// ============================================================================
// Verdict computation (DECLARATIVE)
// ============================================================================

/**
 * Compute pass/fail from the report's summary using a declarative
 * required_clean[] list. Each name in the list must map to a zero-valued
 * summary key; any non-zero counts → `fail`.
 *
 * Unknown summary keys (defensive forward-compat) are treated as 0 —
 * future categories added to required_clean[] without a corresponding
 * summary key behave as no-op (don't accidentally fail every workspace).
 */
export function computeVerdict(summary, requiredClean) {
  const list = Array.isArray(requiredClean) && requiredClean.length > 0
    ? requiredClean
    : DEFAULT_REQUIRED_CLEAN;
  for (const key of list) {
    const v = summary[key];
    if (typeof v === 'number' && v > 0) return 'fail';
  }
  return 'pass';
}

/**
 * Resolve the effective required_clean list given the config object. The
 * lookup is intentionally tolerant — a workspace that hasn't migrated to
 * v2 audit.verdict yet gets the new default. Pass-through string array
 * filter so a malformed config (non-array) silently falls back to default.
 */
export function resolveRequiredClean(config) {
  const raw = config?.audit?.verdict?.required_clean;
  if (!Array.isArray(raw)) return [...DEFAULT_REQUIRED_CLEAN];
  const cleaned = raw.filter((s) => typeof s === 'string' && s.length > 0);
  return cleaned.length > 0 ? cleaned : [...DEFAULT_REQUIRED_CLEAN];
}

/**
 * Resolve the escalate_undeclared_to_anti_pattern flag. Default TRUE per
 * the Move #13 contract — drift_undeclared entries get mirrored into
 * anti_pattern_residual so Tier 3+4 sinks see drift uniformly.
 */
export function resolveDriftEscalation(config) {
  const v = config?.audit?.drift?.escalate_undeclared_to_anti_pattern;
  if (v === false) return false;
  return true;
}

// ============================================================================
// Top-level audit runner — pure
// ============================================================================

/**
 * Run all surfaces and produce the audit-report envelope.
 *
 * `opts.legacyVerdict === true` (back-compat lever): suppresses the new
 * declarative gating and the new manifest_drift surface — restores the
 * pre-Move-#13 3-conjunct expression for emergency rollback / dedicated
 * regression test. Production callers should leave this OFF.
 *
 * `opts.now` — override generated_at (used by tests).
 * `opts.probes` — override the git diff probe chain (used by tests).
 * `opts.state` — pre-loaded state.json (avoids a redundant read when the
 *                wrapper has already loaded it).
 * `opts.config` — pre-loaded config (same rationale as `opts.state`).
 *
 * @returns {{
 *   schema_version: 1, tier: 4, generated_at: string,
 *   verdict: 'pass' | 'fail',
 *   contract_mode: 'legacy_skip' | 'empty_skip' | 'enforced',
 *   summary: { anti_pattern_residual, missing_covers, dangling_covers,
 *              drift_undeclared, drift_unimplemented, manifest_drift },
 *   surfaces: { anti_pattern_residual, missing_covers, dangling_covers,
 *               drift, manifest_drift },
 *   inputs: { decomposition_phases, included_ucs },
 *   verdict_policy: { required_clean: string[],
 *                     escalate_undeclared_to_anti_pattern: boolean,
 *                     legacy_verdict: boolean }
 * }}
 */
export function runCodexAudit(cwd, pluginRoot, opts = {}) {
  const phases = parseDecompositionPhases(cwd);
  const includedUCs = enumerateIncludedUserCases(cwd);
  const fileAbsent = isLegacyContractMode(cwd);
  const emptyIncluded = !fileAbsent && includedUCs.length === 0;
  const graceful = fileAbsent || emptyIncluded;
  const contractMode = fileAbsent ? 'legacy_skip'
    : emptyIncluded ? 'empty_skip'
    : 'enforced';

  const antiPatternResidual = auditAntiPatternResidual(cwd, pluginRoot, phases);
  const { uncovered, dangling } = findMissingCovers(includedUCs, phases, { legacy: graceful });
  const drift = findScopeDrift(cwd, phases, opts);

  // Move #13: manifest_drift surface. Suppressed in legacyVerdict mode so
  // the dedicated rollback regression test sees the pre-Move shape.
  const legacyVerdict = opts.legacyVerdict === true;
  const state = opts.state ?? null;
  const manifestDrift = legacyVerdict
    ? []
    : findManifestDrift(state, phases, cwd);

  // Move #13: drift escalation. When ON (default), each drift_undeclared
  // entry is appended to anti_pattern_residual as a synthetic finding so
  // downstream sinks see drift uniformly. Off in legacyVerdict mode.
  const config = opts.config ?? safeLoadConfig(cwd);
  const escalate = legacyVerdict ? false : resolveDriftEscalation(config);
  const escalated = [];
  if (escalate && Array.isArray(drift?.undeclared)) {
    for (const file of drift.undeclared) {
      escalated.push({
        phase_id: null,
        file,
        id: 'F6.drift_undeclared',
        severity: 'warn',
        line: null,
        snippet: null,
        synthetic: true,
        source: 'drift_undeclared',
      });
    }
  }
  const antiPatternEffective = [...antiPatternResidual, ...escalated];

  const summary = {
    anti_pattern_residual: antiPatternEffective.length,
    missing_covers: uncovered.length,
    dangling_covers: dangling.length,
    drift_undeclared: drift.undeclared.length,
    drift_unimplemented: drift.unimplemented.length,
    manifest_drift: manifestDrift.length,
  };

  const requiredClean = legacyVerdict
    ? [...LEGACY_REQUIRED_CLEAN]
    : resolveRequiredClean(config);

  const verdict = computeVerdict(summary, requiredClean);

  return {
    schema_version: 1,
    tier: 4,
    generated_at: opts.now ?? new Date().toISOString(),
    verdict,
    contract_mode: contractMode,
    summary,
    surfaces: {
      anti_pattern_residual: antiPatternEffective,
      missing_covers: uncovered,
      dangling_covers: dangling,
      drift,
      manifest_drift: manifestDrift,
    },
    inputs: {
      decomposition_phases: phases.length,
      included_ucs: includedUCs.length,
    },
    verdict_policy: {
      required_clean: requiredClean,
      escalate_undeclared_to_anti_pattern: escalate,
      legacy_verdict: legacyVerdict,
    },
  };
}

function safeLoadConfig(cwd) {
  try { return loadConfig(cwd); } catch { return {}; }
}

// ============================================================================
// Decision envelope builders (mirrors gates.mjs / schemas.mjs shape)
// ============================================================================

function pass({ ruleId, verdict, summary, surfaces, contractMode, sideEffects } = {}) {
  return {
    action: 'pass',
    verdict: verdict || 'pass',
    summary: summary || {},
    surfaces: surfaces || {},
    contract_mode: contractMode || 'enforced',
    ruleId: ruleId || null,
    sideEffects: sideEffects || [],
  };
}

function fail({ ruleId, verdict, summary, surfaces, contractMode, sideEffects } = {}) {
  return {
    action: 'fail',
    verdict: verdict || 'fail',
    summary: summary || {},
    surfaces: surfaces || {},
    contract_mode: contractMode || 'enforced',
    ruleId: ruleId || null,
    sideEffects: sideEffects || [],
  };
}

function noop({ ruleId, sideEffects } = {}) {
  return {
    action: 'noop',
    verdict: null,
    summary: {},
    surfaces: {},
    contract_mode: null,
    ruleId: ruleId || null,
    sideEffects: sideEffects || [],
  };
}

// ============================================================================
// (1) PER-PHASE AUDIT — handleAudit (scaffolding for phase-boundary sweeps)
// ============================================================================

/**
 * Per-phase residual audit. Currently a no-op envelope — scaffolding
 * for a future Move that wires phase-boundary anti-pattern sweeps
 * (re-run F3 scan at end-of-phase, before the verifier completes).
 *
 * ctx: { cwd?, pluginRoot?, state?, config?, now? }
 */
export function handleAudit(_ctx = {}) {
  return noop({ ruleId: 'audit_per_phase_noop' });
}

// ============================================================================
// (2) FINALIZE AUDIT — handleFinalizeAudit (Tier 4 verdict)
// ============================================================================

/**
 * Finalize-time Tier 4 audit. Pure-ish: the only effects are returned in
 * `sideEffects` for the wrapper to apply (writeFileSync of audit-report.json
 * + process.exit with the resolved code).
 *
 * ctx: { cwd, pluginRoot, state?, config?, now?, probes?, legacyVerdict? }
 *   - cwd (required): workspace root
 *   - pluginRoot (required): MPL plugin root (where anti-patterns.md lives)
 *   - state: pre-loaded state.json; when omitted the wrapper supplies one
 *   - config: pre-loaded config; when omitted runCodexAudit re-loads
 *
 * Returns:
 *   { action:'pass'|'fail'|'noop', verdict, summary, surfaces, contract_mode,
 *     sideEffects: [
 *       { kind:'audit_report_write', path, payload },
 *       { kind:'audit_exit_code', code }
 *     ] }
 *
 *   exit_code semantics (preserved from legacy CLI):
 *     0 — verdict=pass OR (verdict=fail AND audit_residual !== 'block')
 *     1 — verdict=fail AND audit_residual === 'block'
 *     (the wrapper translates 'no cwd' → exit 2 outside this handler.)
 */
export function handleFinalizeAudit(ctx = {}) {
  const { cwd, pluginRoot, state, config, now, probes, legacyVerdict } = ctx;
  if (!cwd || !pluginRoot) {
    return noop({ ruleId: 'audit_finalize_missing_ctx' });
  }

  const report = runCodexAudit(cwd, pluginRoot, {
    now,
    probes,
    state,
    config,
    legacyVerdict: legacyVerdict === true,
  });

  // Resolve exit code from enforcement.audit_residual. Default 'warn' →
  // fail surfaces but exit 0 (informational). 'block' → fail elevates to
  // exit 1. 'off' → always exit 0.
  const action = resolveRuleAction(cwd, state ?? null, 'audit_residual');
  const exitCode = (report.verdict === 'fail' && action === 'block') ? 1 : 0;

  const sideEffects = [
    {
      kind: 'audit_report_write',
      path: AUDIT_REPORT_PATH,
      payload: report,
    },
    {
      kind: 'audit_exit_code',
      code: exitCode,
    },
  ];

  const envelope = report.verdict === 'pass'
    ? pass({
        ruleId: 'audit_finalize_pass',
        verdict: report.verdict,
        summary: report.summary,
        surfaces: report.surfaces,
        contractMode: report.contract_mode,
        sideEffects,
      })
    : fail({
        ruleId: 'audit_finalize_fail',
        verdict: report.verdict,
        summary: report.summary,
        surfaces: report.surfaces,
        contractMode: report.contract_mode,
        sideEffects,
      });

  // Surface the full report alongside the envelope so the wrapper can
  // write+stdout it without re-running the runner.
  envelope.report = report;
  envelope.enforcement_action = action;
  return envelope;
}

// ============================================================================
// Dispatcher
// ============================================================================

/**
 * `handle('finalize', ctx)` → handleFinalizeAudit
 * `handle('phase', ctx)`    → handleAudit (currently noop)
 */
export function handle(event, ctx = {}) {
  switch (event) {
    case 'finalize': return handleFinalizeAudit(ctx);
    case 'phase':    return handleAudit(ctx);
    default:
      throw new Error(`policy/audit.mjs: unknown event '${event}'`);
  }
}

// Re-export L1 helpers the wrappers commonly need.
export { isMplActive };
