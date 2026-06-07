/**
 * MPL Permit Policy (L2 module — Move #10)
 *
 * SSOT for FIVE wrapper hooks:
 *   1. auto_permit     (PreToolUse)             — mpl-auto-permit.mjs
 *   2. permit_learner  (PostToolUse)            — mpl-permit-learner.mjs
 *   3. bash_timeout    (PreToolUse Bash)        — mpl-bash-timeout.mjs
 *   4. resource_risk   (manual CLI, NOT a hook) — mpl-resource-risk.mjs
 *   5. fallback_grep   (PostToolUse Edit/Write/MultiEdit) — mpl-fallback-grep.mjs
 *
 * Public API:
 *   handle(event, ctx) -> dispatcher
 *   handleAutoPermit(ctx)     -> {action: 'pass-through'|'approve'|'block', ...}
 *   handlePermitLearner(ctx)  -> {action: 'noop'|'learn-tool'|'learn-bash-prefix'|'veto-skip', ...}
 *   handleBashTimeout(ctx)    -> {action: 'silent'|'block'|'warn', ...}
 *   handleResourceRisk(ctx)   -> {action: 'report', payload}
 *   handleFallbackGrep(ctx)   -> {action: 'silent'|'block'|'warn', ...}
 *
 * Eval finding #1c fix (fail-open closure):
 *   The legacy `mpl-auto-permit.mjs` ended the Bash branch with a verbatim
 *   `decision: 'approve'` fail-open for any unknown command. handleAutoPermit
 *   replaces that branch with `classifyBashCommand()` — a layered veto
 *   pipeline (protected-delete / state+decomp / source-target / dangerous-union)
 *   — followed by a configurable `permit.unknown_bash` policy knob.
 *
 *   The learner reuses the SAME `classifyBashCommand()` so a vetoed command
 *   can never be persisted into the learned allowlist (closes the
 *   "learning compounds the asymmetry" finding).
 *
 * Dependency boundary (per hooks/lib/policy/README.md):
 *   - L1 helpers only EXCEPT a narrow exception to `policy/source-edit.mjs`
 *     (pure regex constants + classifier helpers ONLY, no I/O entrypoint).
 *     This mirrors the documented `gates.mjs → contracts.mjs` exception.
 *   - Does NOT import policy/contracts.mjs, policy/gates.mjs,
 *     policy/evidence.mjs, or policy/channel-registry.mjs.
 */

import { existsSync, readFileSync, realpathSync } from 'fs';
import { extname, dirname, join, basename, resolve as resolvePath } from 'path';

// L1 dependencies
import { isMplActive, readState } from '../mpl-state.mjs';
import { loadConfig } from '../mpl-config.mjs';
import { loadConfigV2 } from '../config.mjs';
import { resolveRuleAction } from '../mpl-enforcement.mjs';
import { decideTimeout } from '../bash-timeout-categories.mjs';
import { detectTauriRustResourceRisk } from '../mpl-resource-risk.mjs';
import {
  loadRegistry, isInScope, scanContent, decideAction,
} from '../anti-pattern-registry.mjs';
import {
  isLearnedTool, isLearnedBashCommand, extractBashPrefix,
} from '../permit-store.mjs';

// Narrow L2 exception — pure helpers + regex constants only.
import {
  normalizeShellCommand,
  extractBashWriteTargets,
  matchesProtectedDelete,
  isAllowedPath,
  isSourceFile,
  isDangerousBashCommand,
  isDogfoodMode,
  DANGEROUS_BASH_PATTERNS as SOURCE_DANGEROUS_PATTERNS,
  PROTECTED_DELETE_TARGETS,
  DECOMPOSITION_FILE_REGEX,
  STATE_FILE_REGEX,
} from './source-edit.mjs';

// ============================================================================
// Shared constants — re-exported for back-compat
// ============================================================================

export const PERMIT_HOOK_IDS = Object.freeze({
  auto_permit:    'mpl-auto-permit',
  permit_learner: 'mpl-permit-learner',
  bash_timeout:   'mpl-bash-timeout',
  resource_risk:  'mpl-resource-risk',
  fallback_grep:  'mpl-fallback-grep',
});

export const PERMIT_LEARNED_STORE_PATH = '.mpl/auto-permit-learned.json';

// Tools that are always safe to auto-approve (legacy verbatim).
export const ALWAYS_SAFE_TOOLS = new Set([
  'Read', 'Glob', 'Grep',
  'Agent', 'Task',
  'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TaskOutput',
  'WebSearch', 'WebFetch',
  'AskUserQuestion',
  'NotebookEdit',
  'ToolSearch',
]);

// Tools handled by other hooks (write-guard) — don't interfere.
export const DEFER_TOOLS = new Set(['Edit', 'Write']);

// Legacy auto-permit dangerous patterns (verbatim).
export const DANGEROUS_BASH_PATTERNS = [
  /git\s+push\s+.*--force/,
  /git\s+push\s+-f\b/,
  /git\s+reset\s+--hard/,
  /git\s+branch\s+-[dD]\s/,
  /git\s+checkout\s+--\s/,
  /git\s+clean\s+-f/,
  /\brm\s+-rf?\s+(?!\.mpl)/,
  /\bsudo\b/,
  /DROP\s+TABLE/i,
  /DELETE\s+FROM/i,
  /\bgit\s+rebase\b/,
  /\bgit\s+merge\b/,
  /\bgit\s+stash\s+drop\b/,
];

// Safe Bash command prefixes (legacy verbatim).
export const SAFE_BASH_PREFIXES = [
  'git status', 'git diff', 'git log', 'git show', 'git branch',
  'git add', 'git commit',
  'ls', 'pwd', 'which', 'echo', 'cat', 'head', 'tail', 'wc',
  'node ', 'npm ', 'npx ', 'pnpm ', 'yarn ',
  'python ', 'python3 ', 'pip ', 'pytest ', 'uv ',
  'cargo ', 'go ', 'make ', 'cmake ',
  'tsc ', 'eslint ', 'prettier ',
  'grep ', 'rg ', 'find ', 'ag ',
  'curl ', 'wget ',
  'mkdir ', 'touch ', 'cp ',
  'git checkout -b', 'git switch',
  'gh ',
  'cd ',
  'date', 'whoami', 'env',
];

export const UNKNOWN_BASH_DEFAULT = 'pass-through';
const VALID_UNKNOWN_BASH = new Set(['pass-through', 'block-strict', 'allow-loose']);

const REGISTRY_RELATIVE = 'commands/references/anti-patterns.md';
const SIGNALS_RELATIVE = '.mpl/signals/anti-pattern-hits.jsonl';

// ============================================================================
// Config loading — prefer v2 (YAML SSOT) with legacy .mpl/config.json fallback
// ============================================================================

/**
 * Load the merged config that resolveUnknownBashPolicy + handleAutoPermit +
 * handleBashTimeout / handlePermitLearner consume. Tries `loadConfigV2`
 * first so `mpl.config.yaml` knobs flow through (e.g.
 * `permit.unknown_bash`), then falls back to the legacy `.mpl/config.json`
 * loader. Both return shapes are object-compatible.
 *
 * resolveUnknownBashPolicy's existing precedence chain still applies:
 *   1. .mpl/config.json#permit.unknown_bash (highest — runtime override)
 *   2. the merged config object (which now carries the YAML value)
 *   3. UNKNOWN_BASH_DEFAULT
 *
 * Failures are swallowed so an unreadable YAML never breaks auto-permit.
 *
 * @param {string} cwd
 * @returns {object}
 */
function _loadMergedConfig(cwd) {
  try {
    const v2 = loadConfigV2(cwd);
    if (v2 && typeof v2 === 'object') return v2;
  } catch { /* fall through to legacy */ }
  try {
    const legacy = loadConfig(cwd);
    if (legacy && typeof legacy === 'object') return legacy;
  } catch { /* fall through */ }
  return {};
}

// ============================================================================
// Knob resolution
// ============================================================================

/**
 * Resolve `permit.unknown_bash` knob.
 *
 * Resolution order:
 *   1. .mpl/config.json#permit.unknown_bash (runtime override)
 *   2. mpl.config.yaml#permit.unknown_bash — wired via the v2 loader.
 *      `handleAutoPermit` now threads a `loadConfigV2`-first merged config
 *      (see `_loadMergedConfig`) so the YAML SSOT is automatically picked
 *      up here without each caller manually merging.
 *   3. hardcoded default UNKNOWN_BASH_DEFAULT ('pass-through')
 *
 * @param {string} cwd
 * @param {object} [config] — optional pre-loaded config (allows tests to inject)
 * @returns {'pass-through' | 'block-strict' | 'allow-loose'}
 */
export function resolveUnknownBashPolicy(cwd, config) {
  // Step 1: .mpl/config.json (highest precedence)
  try {
    const cfgPath = join(cwd, '.mpl', 'config.json');
    if (existsSync(cfgPath)) {
      const raw = JSON.parse(readFileSync(cfgPath, 'utf-8'));
      const v = raw?.permit?.unknown_bash;
      if (typeof v === 'string' && VALID_UNKNOWN_BASH.has(v)) return v;
    }
  } catch { /* fall through */ }

  // Step 2: passed config (typically the merged loadConfig() result; some
  // callers stash YAML knobs under .permit there too).
  if (config && typeof config === 'object') {
    const v = config?.permit?.unknown_bash;
    if (typeof v === 'string' && VALID_UNKNOWN_BASH.has(v)) return v;
  }

  return UNKNOWN_BASH_DEFAULT;
}

// ============================================================================
// Shared Bash classifier — SSOT for auto-permit + permit-learner
// ============================================================================

function isLegacyDangerousBash(command) {
  if (!command) return false;
  return DANGEROUS_BASH_PATTERNS.some((p) => p.test(command));
}

function isUnionDangerousBash(command) {
  // Union of legacy auto-permit patterns AND source-edit dangerous patterns —
  // closes the disjoint-list gap from the eval finding.
  if (isLegacyDangerousBash(command)) return true;
  if (isDangerousBashCommand(command)) return true;
  return false;
}

function realpathOrParent(targetAbs) {
  try { return realpathSync(targetAbs); }
  catch {
    try { return join(realpathSync(dirname(targetAbs)), basename(targetAbs)); }
    catch { return null; }
  }
}

function writesToProtectedRegex(normalizedCommand, cwd, regex) {
  // Inspect every redirect/tee/dd of= target for direct or symlinked matches
  // against the supplied regex (.mpl/state.json or .mpl/mpl/decomposition.yaml).
  if (regex.test(normalizedCommand)) {
    // Direct mention with a write op?
    const writes = (
      /[\d&]?>{1,2}[^|;&\n]*/.test(normalizedCommand) ||
      /\btee\b/.test(normalizedCommand) ||
      /\bdd\b[^|;&]*\bof=/.test(normalizedCommand) ||
      /\bcat\b[^|;&]*[\d&]?>{1,2}/.test(normalizedCommand)
    );
    if (writes) return true;
  }
  // Symlink resolution path: every operand of a write op is realpath-checked.
  const writeTargetRe = /(?:[\d&]?>{1,2}\s*|\btee\b(?:\s+-\S+)*\s+|\bdd\b[^|;&]*\bof=\s*)([^\s|;&]+)/g;
  for (const m of normalizedCommand.matchAll(writeTargetRe)) {
    const target = m[1];
    let abs;
    try { abs = resolvePath(cwd, target); } catch { continue; }
    if (regex.test(abs)) return true;
    const resolved = realpathOrParent(abs);
    if (resolved && regex.test(resolved)) return true;
  }
  return false;
}

function classifyConcreteTargets(extracted, cwd, dogfood) {
  // Mirror policy/source-edit::classifyTargets, but expose only the
  // veto-relevant fields we need (we don't surface opaque-only writes here —
  // those stay in source-edit's warn-tier; permit-side veto is concrete only).
  const concrete = [];
  for (const t of extracted) {
    const { target, opaque } = t;
    if (!target) continue;
    if (opaque === true) continue;
    // DEV_NULL_SINKS and similar are already filtered by extractBashWriteTargets.

    if (isAllowedPath(target, { dogfood })) continue;
    let abs;
    try { abs = resolvePath(cwd, target); } catch { continue; }
    if (isAllowedPath(abs, { dogfood })) continue;
    const resolved = realpathOrParent(abs);
    if (resolved && isAllowedPath(resolved, { dogfood })) continue;
    const sourceLike = isSourceFile(target) || (resolved && isSourceFile(resolved));
    if (!sourceLike) continue;
    concrete.push({ target, source: t.source, abs, resolved });
  }
  return concrete;
}

/**
 * Layered Bash veto classifier — SSOT for both handleAutoPermit and
 * handlePermitLearner. Runs four veto layers in order; short-circuits on
 * first hit:
 *   (a) UNION of legacy + source-edit DANGEROUS_BASH_PATTERNS
 *   (b) matchesProtectedDelete (.mpl/mpl, .mpl/contracts, .mpl/memory, docs/learnings)
 *   (c) state.json / decomposition.yaml write detection (incl. symlink resolve)
 *   (d) extractBashWriteTargets → concrete source-file targets outside allowlist
 *
 * @param {string} cwd
 * @param {string} command
 * @param {object} [state]
 * @param {object} [options] — { dogfood?: boolean }
 * @returns {{
 *   veto: null | { category: string, target?: string, source?: string, reason: string },
 *   dangerous: boolean
 * }}
 */
export function classifyBashCommand(cwd, command, state, options = {}) {
  const dangerous = isUnionDangerousBash(command);

  if (!command || typeof command !== 'string') {
    return { veto: null, dangerous };
  }

  // (a) Dangerous-union veto.
  if (dangerous) {
    return {
      veto: {
        category: 'dangerous_bash',
        reason: `[MPL Permit] dangerous Bash pattern detected: ${command.slice(0, 80)}${command.length > 80 ? '…' : ''}`,
      },
      dangerous,
    };
  }

  // (b) Protected-delete veto.
  const protectedTarget = matchesProtectedDelete(command, cwd);
  if (protectedTarget) {
    return {
      veto: {
        category: 'protected_delete',
        target: protectedTarget,
        reason: `[MPL Permit] destructive write to protected path "${protectedTarget}"`,
      },
      dangerous,
    };
  }

  const normalized = normalizeShellCommand(command);
  const normalizedLower = normalized.toLowerCase();

  // (c) state.json / decomposition.yaml write detection.
  if (writesToProtectedRegex(normalizedLower, cwd, /\.mpl\/state\.json/i)) {
    return {
      veto: {
        category: 'state_json_write',
        target: '.mpl/state.json',
        reason: '[MPL Permit] Bash write to .mpl/state.json detected',
      },
      dangerous,
    };
  }
  if (writesToProtectedRegex(normalizedLower, cwd, /\.mpl\/mpl\/decomposition\.ya?ml/i)) {
    return {
      veto: {
        category: 'decomposition_write',
        target: '.mpl/mpl/decomposition.yaml',
        reason: '[MPL Permit] Bash write to .mpl/mpl/decomposition.yaml detected',
      },
      dangerous,
    };
  }

  // (d) Source-target veto via extractBashWriteTargets.
  const dogfood = options.dogfood === true || isDogfoodMode(cwd);
  const extracted = extractBashWriteTargets(normalized);
  if (extracted.length > 0) {
    const concrete = classifyConcreteTargets(extracted, cwd, dogfood);
    if (concrete.length > 0) {
      const first = concrete[0];
      return {
        veto: {
          category: 'source_target',
          target: first.target,
          source: first.source,
          reason: `[MPL Permit] Bash command writes to source file "${first.target}" via ${first.source}`,
        },
        dangerous,
      };
    }
  }

  return { veto: null, dangerous };
}

// ============================================================================
// (1) AUTO-PERMIT — PreToolUse decision graph
// ============================================================================

function isSafeBash(command) {
  if (!command) return false;
  const trimmed = command.trim();
  return SAFE_BASH_PREFIXES.some((p) => trimmed.startsWith(p));
}

/**
 * @param {{cwd:string, toolName:string, toolInput?:object, state?:object,
 *          config?:object, isMplActive?:boolean}} ctx
 * @returns {{action:'pass-through'|'approve'|'block', reason?:string,
 *           vetoCategory?:string, sideEffects?:Array}}
 */
export function handleAutoPermit(ctx = {}) {
  const cwd = ctx.cwd || process.cwd();
  const toolName = String(ctx.toolName || '');
  const toolInput = ctx.toolInput || {};

  // MPL-active check.
  const active = typeof ctx.isMplActive === 'boolean' ? ctx.isMplActive : isMplActive(cwd);
  if (!active) return { action: 'pass-through' };

  // Defer tools (write-guard owns them).
  if (DEFER_TOOLS.has(toolName)) return { action: 'pass-through' };

  // Always-safe tools.
  if (ALWAYS_SAFE_TOOLS.has(toolName)) return { action: 'approve' };

  // Learned tools.
  if (isLearnedTool(cwd, toolName)) return { action: 'approve' };

  // Bash branch.
  if (toolName === 'Bash') {
    const command = toolInput.command || '';
    const state = ctx.state || readState(cwd) || {};
    // Prefer v2 (YAML SSOT) so `permit.unknown_bash` declared in
    // mpl.config.yaml flows into resolveUnknownBashPolicy's step 2; legacy
    // .mpl/config.json still wins via step 1.
    const config = ctx.config || _loadMergedConfig(cwd);

    // STEP 1: layered veto pipeline (closes fail-open).
    const classification = classifyBashCommand(cwd, command, state);
    if (classification.veto) {
      // pass-through (not block) — write-guard / source-edit produce the
      // authoritative user-facing block; Claude Code prompts the user.
      return {
        action: 'pass-through',
        reason: classification.veto.reason,
        vetoCategory: classification.veto.category,
      };
    }

    // STEP 2: SAFE_BASH_PREFIXES + learned-prefix lookup.
    if (isSafeBash(command)) return { action: 'approve' };
    if (isLearnedBashCommand(cwd, command)) return { action: 'approve' };

    // STEP 3: unknown-Bash policy knob.
    const policy = resolveUnknownBashPolicy(cwd, config);
    if (policy === 'block-strict') {
      const trimmed = command.trim();
      const prefix = trimmed.split(/\s+/)[0] || trimmed.slice(0, 32);
      return {
        action: 'block',
        reason: `[MPL Permit] unknown_bash=block-strict: unknown bash prefix "${prefix}" requires explicit allowlist`,
        vetoCategory: 'unknown_bash_strict',
      };
    }
    if (policy === 'allow-loose') {
      return { action: 'approve' };
    }
    // default: pass-through (fail-closed against fail-open).
    return { action: 'pass-through' };
  }

  // Unknown tool: pass through (user decides) → learner captures if approved.
  return { action: 'pass-through' };
}

// ============================================================================
// (2) PERMIT-LEARNER — PostToolUse, symmetric to auto-permit
// ============================================================================

function isBuiltinSafeBashLegacy(command) {
  // Matches the legacy permit-learner `isBuiltinSafeBash` semantics so the
  // skip-when-already-known fast path stays verbatim.
  return isSafeBash(command);
}

/**
 * @param {{cwd:string, toolName:string, toolInput?:object, state?:object,
 *          config?:object, isMplActive?:boolean}} ctx
 * @returns {{action:'noop'|'learn-tool'|'learn-bash-prefix'|'veto-skip',
 *           toolName?:string, prefix?:string, vetoCategory?:string}}
 */
export function handlePermitLearner(ctx = {}) {
  const cwd = ctx.cwd || process.cwd();
  const toolName = String(ctx.toolName || '');

  const active = typeof ctx.isMplActive === 'boolean' ? ctx.isMplActive : isMplActive(cwd);
  if (!active) return { action: 'noop' };

  // Skip already-covered built-ins.
  if (ALWAYS_SAFE_TOOLS.has(toolName) || DEFER_TOOLS.has(toolName)) {
    return { action: 'noop' };
  }

  // Bash branch — reuse the SAME classifyBashCommand veto.
  if (toolName === 'Bash') {
    const toolInput = ctx.toolInput || {};
    const command = toolInput.command || '';

    // SYMMETRY GUARANTEE: if auto-permit's veto would fire, never persist.
    const classification = classifyBashCommand(cwd, command, ctx.state);
    if (classification.veto) {
      return {
        action: 'veto-skip',
        vetoCategory: classification.veto.category,
      };
    }

    // Skip if already known (built-in or learned).
    if (isBuiltinSafeBashLegacy(command) || isLearnedBashCommand(cwd, command)) {
      return { action: 'noop' };
    }

    const prefix = extractBashPrefix(command);
    if (!prefix) return { action: 'noop' };
    return { action: 'learn-bash-prefix', prefix };
  }

  // Non-Bash tool — learn if not already learned.
  if (!isLearnedTool(cwd, toolName)) {
    return { action: 'learn-tool', toolName };
  }
  return { action: 'noop' };
}

// ============================================================================
// (3) BASH-TIMEOUT — thin wrapper over decideTimeout + ruleAction
// ============================================================================

/**
 * @param {{cwd:string, toolName:string, toolInput?:object, state?:object,
 *          config?:object, isMplActive?:boolean}} ctx
 * @returns {{action:'silent'|'block'|'warn', reason?:string, decision?:object}}
 */
export function handleBashTimeout(ctx = {}) {
  const cwd = ctx.cwd || process.cwd();
  const toolName = String(ctx.toolName || '');

  if (!['Bash', 'bash'].includes(toolName)) return { action: 'silent' };

  const active = typeof ctx.isMplActive === 'boolean' ? ctx.isMplActive : isMplActive(cwd);
  if (!active) return { action: 'silent' };

  const toolInput = ctx.toolInput || {};
  const command = toolInput.command || '';
  const timeoutMs = toolInput.timeout;

  const state = ctx.state || readState(cwd) || {};
  const ruleAction = resolveRuleAction(cwd, state, 'bash_timeout_violation');
  if (ruleAction === 'off') return { action: 'silent' };
  const strict = ruleAction === 'block';

  // Prefer v2 (YAML SSOT) so any YAML-side bash_timeout knobs flow through;
  // legacy .mpl/config.json still wins because _loadMergedConfig deep-merges
  // the YAML defaults with the legacy loader as fallback.
  const cfg = ctx.config || _loadMergedConfig(cwd);
  const decision = decideTimeout(command, timeoutMs, {
    strict,
    configOverride: cfg?.bash_timeout,
  });

  if (decision.action === 'silent') return { action: 'silent', decision };
  if (decision.action === 'block') {
    return { action: 'block', reason: decision.reason, decision };
  }
  return { action: 'warn', reason: decision.reason, decision };
}

// ============================================================================
// (4) RESOURCE-RISK — wraps detectTauriRustResourceRisk (side-effect free)
// ============================================================================

/**
 * @param {{cwd:string}} ctx
 * @returns {{action:'report', payload:object}}
 */
export function handleResourceRisk(ctx = {}) {
  const cwd = ctx.cwd || process.cwd();
  const payload = detectTauriRustResourceRisk(cwd);
  return { action: 'report', payload };
}

// ============================================================================
// (5) FALLBACK-GREP — anti-pattern scan + decideAction; logRecords[] for wrapper
// ============================================================================

function workspaceRel(cwd, abs) {
  const cwdAbs = resolvePath(cwd);
  const path = resolvePath(abs);
  return path.startsWith(cwdAbs + '/') ? path.slice(cwdAbs.length + 1) : abs;
}

function buildLogRecords(file, hits, action) {
  if (!hits || hits.length === 0) return [];
  const ts = new Date().toISOString();
  return hits.map((h) => ({
    ts,
    file,
    id: h.id,
    severity: h.severity,
    escalation: h.escalation,
    line: h.line,
    snippet: h.snippet,
    regex: h.regex,
    action,
  }));
}

/**
 * Path-extension-scoped anti-pattern observer. Returns decision envelope with
 * `logRecords[]` for the wrapper to persist (mirrors Move #9's
 * policy-returns-decision, wrapper-owns-I/O split).
 *
 * @param {{cwd:string, toolName:string, toolInput?:object, state?:object,
 *          pluginRoot?:string, isMplActive?:boolean}} ctx
 * @returns {{
 *   action: 'silent'|'block'|'warn',
 *   reason?: string,
 *   hits?: Array,
 *   blockingDetails?: Array,
 *   logRecords?: Array,
 * }}
 */
export function handleFallbackGrep(ctx = {}) {
  const cwd = ctx.cwd || process.cwd();
  const toolName = String(ctx.toolName || '');

  if (!['Edit', 'edit', 'Write', 'write', 'MultiEdit', 'multiEdit'].includes(toolName)) {
    return { action: 'silent' };
  }

  const active = typeof ctx.isMplActive === 'boolean' ? ctx.isMplActive : isMplActive(cwd);
  if (!active) return { action: 'silent' };

  const toolInput = ctx.toolInput || {};
  const filePaths = [];
  if (toolInput.file_path) filePaths.push(toolInput.file_path);
  else if (toolInput.filePath) filePaths.push(toolInput.filePath);
  if (Array.isArray(toolInput.edits)) {
    for (const e of toolInput.edits) {
      if (e?.file_path) filePaths.push(e.file_path);
      else if (e?.filePath) filePaths.push(e.filePath);
    }
  }
  if (filePaths.length === 0) return { action: 'silent' };

  const pluginRoot = ctx.pluginRoot;
  if (!pluginRoot) return { action: 'silent' };
  const registryPath = join(pluginRoot, REGISTRY_RELATIVE);
  if (!existsSync(registryPath)) return { action: 'silent' };

  let registry;
  try { registry = loadRegistry(registryPath); }
  catch { return { action: 'silent' }; }

  const state = ctx.state || readState(cwd) || {};
  const ruleAction = resolveRuleAction(cwd, state, 'anti_pattern_match');
  const strict = ruleAction === 'block';

  const allHits = [];
  const blockingDetails = [];
  const logRecords = [];

  for (const fp of filePaths) {
    const abs = resolvePath(cwd, fp);
    if (!isInScope(abs, registry.scope)) continue;
    if (!existsSync(abs)) continue;
    let content;
    try { content = readFileSync(abs, 'utf-8'); } catch { continue; }
    const hits = scanContent(content, registry.patterns);
    const decision = decideAction(hits, { strict });
    const rel = workspaceRel(cwd, abs);
    const recordedAction = ruleAction === 'off' ? 'off' : decision.action;
    logRecords.push(...buildLogRecords(rel, hits, recordedAction));
    if (hits.length > 0) {
      allHits.push({ file: rel, hits, decision });
      if (decision.action === 'block') blockingDetails.push({ file: rel, decision });
    }
  }

  if (ruleAction === 'off') {
    return { action: 'silent', logRecords };
  }
  if (allHits.length === 0) {
    return { action: 'silent', logRecords };
  }

  if (blockingDetails.length > 0) {
    const reasons = blockingDetails.map((b) => `${b.file}: ${b.decision.summary}`).join('\n');
    return {
      action: 'block',
      reason: `[MPL F3] strict mode anti-pattern block:\n${reasons}`,
      hits: allHits,
      blockingDetails,
      logRecords,
    };
  }

  const summary = allHits.map((h) => `${h.file}: ${h.decision.summary}`).join('\n');
  return {
    action: 'warn',
    reason: `[MPL F3] Tier 1 anti-pattern advisory:\n${summary}`,
    hits: allHits,
    logRecords,
  };
}

// ============================================================================
// Top-level dispatch
// ============================================================================

/**
 * @param {'auto_permit'|'permit_learner'|'bash_timeout'|'resource_risk'|'fallback_grep'} event
 * @param {object} ctx
 */
export function handle(event, ctx = {}) {
  switch (event) {
    case 'auto_permit':    return handleAutoPermit(ctx);
    case 'permit_learner': return handlePermitLearner(ctx);
    case 'bash_timeout':   return handleBashTimeout(ctx);
    case 'resource_risk':  return handleResourceRisk(ctx);
    case 'fallback_grep':  return handleFallbackGrep(ctx);
    default:
      throw new Error(`policy/permit.mjs: unknown event '${event}'`);
  }
}

// Re-export the L1 helper the wrappers commonly need.
export { isMplActive };

// Re-export the signals path so wrappers don't duplicate the constant.
export { SIGNALS_RELATIVE as PERMIT_SIGNALS_RELATIVE };
