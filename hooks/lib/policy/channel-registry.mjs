/**
 * MPL Channel Registry Policy (L2 module — Move #7)
 *
 * SSOT for two L2 policy decisions over `.mpl/` writes:
 *
 *   1. ALLOWLIST — classify a workspace-relative path against the
 *      declarative channel set loaded from
 *      `mpl.config.yaml > channels.allowed[]`. Any `.mpl/` path that
 *      matches NO allowed channel glob and matches NO forbidden_patterns
 *      entry is rejected as `unregistered_channel`. Top-level sentinel /
 *      state files (`.mpl/state.json`, `.mpl/config.json`, etc.) are
 *      whitelisted as explicit channels.
 *
 *   2. IMMUTABILITY — given `(path, oldText, newText, state, cwd)`,
 *      compose a chain of registered evaluators
 *      (`always`, `always_after_first_write`,
 *      `phase_lifecycle.phase_id_completed`,
 *      `completed_phase_block_unchanged`,
 *      `baseline_renewal_sentinel_absent`) and emit one of
 *      `{allow | block(code, reason, retryContext)}` verdicts.
 *
 * Composition strategy
 *   This module does NOT re-implement the existing logic in
 *   `lib/mpl-completed-phase-immutability.mjs`,
 *   `lib/mpl-artifact-schema.mjs`, and `lib/mpl-baseline.mjs`. It
 *   COMPOSES them, owning ONLY:
 *
 *     - channel classification (allowed-glob match)
 *     - forbidden-pattern matching
 *     - immutability rule dispatch by `when`-clause
 *     - merging the multi-source verdict into a uniform decision envelope
 *
 * Dependency boundary (per hooks/lib/policy/README.md)
 *   Imports ONLY from L1 (`mpl-state.mjs`, `mpl-config.mjs`) plus the
 *   three existing lib helpers
 *   (`mpl-baseline.mjs`, `mpl-completed-phase-immutability.mjs`,
 *   `mpl-artifact-schema.mjs`) and `mpl-blocked-hook.mjs`.
 *
 *   NEVER imports another `policy/*.mjs`.
 *
 * Glob semantics
 *   `*`     — single path segment (no `/`)
 *   `**`    — zero or more segments
 *   `{a,b}` — brace expansion
 *   `phase-*` — matches `phase-1`, `phase-2-login`, etc.
 *
 * Path normalization MUST run through `posix.normalize()` first to
 * defeat traversal forgery like `.mpl/foo/../scratchpad.md`.
 */

import { existsSync } from 'fs';
import { posix as posixPath, resolve as resolvePath } from 'path';

import {
  baselineExists,
  renewalAuthorized,
  BASELINE_FILE,
  RENEWAL_FLAG_FILE,
} from '../mpl-baseline.mjs';
import {
  completedPhaseIds,
  validateCompletedPhaseImmutability,
} from '../mpl-completed-phase-immutability.mjs';
import {
  matchArtifactSchema,
  validateArtifactFile,
} from '../mpl-artifact-schema.mjs';
import { resolveRuleAction } from '../mpl-enforcement.mjs';

// ============================================================================
// Constants and path normalization
// ============================================================================

/**
 * Normalize a file path to its workspace-relative posix form. Defeats
 * `..` traversal forgery (`.mpl/foo/../scratchpad.md` → `.mpl/scratchpad.md`).
 * Returns empty string for unusable input.
 */
export function normalizePosixPath(p) {
  if (typeof p !== 'string' || !p) return '';
  let normalized = p.replace(/\\/g, '/');
  normalized = posixPath.normalize(normalized);
  // Strip leading `./`
  if (normalized.startsWith('./')) normalized = normalized.slice(2);
  return normalized;
}

/**
 * Workspace-relative path: if `filePath` is absolute under cwd, strip
 * cwd. Otherwise treat as already-relative. Always returns a posix path.
 */
export function workspaceRelative(cwd, filePath) {
  if (!filePath) return '';
  const fp = String(filePath).replace(/\\/g, '/');
  if (!cwd) return normalizePosixPath(fp);
  const cwdAbs = resolvePath(cwd).replace(/\\/g, '/');
  if (fp.startsWith(cwdAbs + '/')) {
    return normalizePosixPath(fp.slice(cwdAbs.length + 1));
  }
  // Already relative? Resolve relative to cwd, then strip.
  if (fp.startsWith('/')) {
    // Absolute but not under cwd → just normalize raw.
    return normalizePosixPath(fp);
  }
  return normalizePosixPath(fp);
}

// ============================================================================
// Glob → RegExp conversion (cached at registry load time)
// ============================================================================

function escapeRegex(s) {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function expandBraces(glob) {
  // Iteratively expand `{a,b,c}` segments into alternatives.
  // Returns an array of expanded glob strings.
  let queue = [glob];
  let changed = true;
  while (changed) {
    changed = false;
    const next = [];
    for (const g of queue) {
      const m = g.match(/^([^{}]*)\{([^{}]+)\}(.*)$/);
      if (m && m[2].includes(',')) {
        const [, pre, body, post] = m;
        for (const part of body.split(',')) {
          next.push(`${pre}${part}${post}`);
        }
        changed = true;
      } else {
        next.push(g);
      }
    }
    queue = next;
  }
  return queue;
}

/**
 * Convert a single (brace-expanded) glob to an anchored RegExp.
 *
 * Glob semantics:
 *   - `**` → `.*` (zero or more segments, including `/`)
 *   - `*`  → `[^/]*` (single path segment)
 *   - `?`  → `[^/]` (single non-slash char)
 *   - everything else → literal
 *
 * The returned RegExp captures `{phase_id}` substring (i.e. the value
 * matched where the glob contained `phase-*`) on a best-effort basis:
 * if the glob contains `phase-*`, that `*` capture is exposed as a
 * named `<phase_id>` group. We rewrite only the FIRST `phase-*`
 * occurrence to a capture so the typical
 * `.mpl/mpl/phases/phase-X/state-summary.md` glob extracts the phase id.
 */
function singleGlobToRegex(glob) {
  // Convert step-by-step, char by char.
  let out = '';
  let i = 0;
  let capturedPhaseId = false;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**` — zero-or-more segments. Special-case `/**` at the end
        // (or `/**/` mid-pattern) so the leading `/` becomes optional:
        // `.mpl/cache/**` matches both `.mpl/cache` and `.mpl/cache/x`.
        // We do this by retro-actively making the previous `/` optional.
        // `/` is not escaped by escapeRegex, so `out` ends in a bare `/`.
        if (out.endsWith('/')) {
          out = out.slice(0, -1) + '(?:/.*)?';
          i += 2;
          // consume trailing `/` if present (`/**/`).
          if (glob[i] === '/') i += 1;
        } else {
          out += '.*';
          i += 2;
          if (glob[i] === '/') i += 1;
        }
        continue;
      }
      // single `*` — single segment.
      // Detect `phase-*` capture: previous chars ended in `phase-`.
      // `-` is not in escapeRegex's set, so the literal `phase-` is
      // emitted as-is into the compiled regex.
      if (!capturedPhaseId && out.endsWith('phase-')) {
        out += '(?<phase_id>[^/]*)';
        capturedPhaseId = true;
      } else {
        out += '[^/]*';
      }
      i += 1;
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    out += escapeRegex(ch);
    i += 1;
  }
  return new RegExp(`^${out}$`);
}

/**
 * Compile a glob (potentially containing `{a,b}` braces) into a list of
 * RegExps. Cached at registry load time.
 */
export function compileGlob(glob) {
  const expanded = expandBraces(String(glob || ''));
  return expanded.map(singleGlobToRegex);
}

function anyRegexMatches(regexes, value) {
  for (const re of regexes) {
    const m = re.exec(value);
    if (m) return m;
  }
  return null;
}

// ============================================================================
// Channel-registry loader
// ============================================================================

const DEFAULT_ALLOWED = Object.freeze([
  { path: '.mpl/state.json', writers: ['engine', 'worker', 'mcp'], category: 'state' },
  { path: '.mpl/config.json', writers: ['user', 'engine'], category: 'config' },
  { path: '.mpl/config/**/*.json', writers: ['user', 'engine'], category: 'config' },
  { path: '.mpl/goal-contract.yaml', writers: ['interviewer'], category: 'contract', schema: 'goal_contract' },
  { path: '.mpl/pivot-points.md', writers: ['interviewer'], category: 'contract', schema: 'pivot_points' },
  { path: '.mpl/requirements/user-contract.md', writers: ['interviewer'], category: 'contract', schema: 'user_contract' },
  { path: '.mpl/mpl/decomposition.yaml', writers: ['planner'], category: 'decomposition', schema: 'decomposition' },
  { path: '.mpl/mpl/decomposition-derived.json', writers: ['planner'], category: 'decomposition' },
  { path: '.mpl/mpl/decomposition-delta.yaml', writers: ['planner'], category: 'decomposition' },
  { path: '.mpl/mpl/decomposition-deltas/recompose-*.yaml', writers: ['planner'], category: 'decomposition' },
  { path: '.mpl/mpl/baseline.yaml', writers: ['interviewer'], category: 'baseline' },
  { path: '.mpl/mpl/.baseline-renewal', writers: ['orchestrator'], category: 'sentinel' },
  { path: '.mpl/mpl/phases/phase-*/state-summary.md', writers: ['executor'], category: 'phase', schema: 'state_summary' },
  { path: '.mpl/mpl/phases/phase-*/verification.md', writers: ['verifier'], category: 'phase', schema: 'verification' },
  { path: '.mpl/mpl/phases/phase-*/phase-seed.yaml', writers: ['planner'], category: 'phase' },
  { path: '.mpl/mpl/phases/phase-*/changes.diff', writers: ['executor'], category: 'phase' },
  { path: '.mpl/mpl/phases/phase-*/warnings.json', writers: ['executor', 'verifier'], category: 'phase' },
  { path: '.mpl/mpl/phases/phase-*/reflections/attempt-*.md', writers: ['executor'], category: 'phase' },
  { path: '.mpl/contracts/*.json', writers: ['planner'], category: 'contract' },
  { path: '.mpl/mpl/phase0/**', writers: ['analyzer'], category: 'phase0' },
  { path: '.mpl/mpl/chains/chain-*/chain-seed.yaml', writers: ['planner'], category: 'chain' },
  { path: '.mpl/mpl/profile/**', writers: ['engine'], category: 'profile', append_only: true },
  { path: '.mpl/signals/**', writers: ['engine', 'hooks'], category: 'signals', append_only: true },
  { path: '.mpl/memory/{semantic,episodic,learnings,working}.md', writers: ['engine'], category: 'memory' },
  { path: '.mpl/memory/{procedural,routing-patterns}.jsonl', writers: ['engine'], category: 'memory', append_only: true },
  { path: '.mpl/cache/**', writers: ['engine'], category: 'cache' },
  { path: '.mpl/archive/**', writers: ['engine'], category: 'archive' },
  { path: '.mpl/research/**', writers: ['research'], category: 'research' },
  { path: '.mpl/e2e-traces/**', writers: ['executor'], category: 'traces' },
  { path: '.mpl/mpl/checkpoints/**', writers: ['engine'], category: 'checkpoint' },
  { path: '.mpl/mpl/releases/**', writers: ['engine'], category: 'release' },
  { path: '.mpl/PLAN.md', writers: ['engine'], category: 'plan' },
  { path: '.mpl/discoveries.md', writers: ['engine'], category: 'discoveries', append_only: true },
  { path: '.mpl/auto-permit-learned.json', writers: ['hooks'], category: 'permit' },
  { path: '.mpl/context-usage.json', writers: ['hooks'], category: 'hud' },
]);

const DEFAULT_IMMUTABLE_WHEN = Object.freeze([
  { match: '.mpl/mpl/baseline.yaml', when: 'baseline_renewal_sentinel_absent' },
  { match: '.mpl/mpl/phases/phase-*/**', when: 'phase_lifecycle.phase_id_completed', applies_to: 'phase_id' },
  { match: '.mpl/mpl/decomposition.yaml', when: 'completed_phase_block_unchanged' },
  { match: '.mpl/pivot-points.md', when: 'always_after_first_write' },
  { match: '.mpl/contracts/*.json', when: 'phase_lifecycle.phase_id_completed', applies_to: 'contract_phase_id' },
]);

const DEFAULT_FORBIDDEN = Object.freeze([
  '.mpl/scratchpad*',
  '.mpl/scratch/**',
  '.mpl/notes/**',
  '.mpl/notes.md',
  '.mpl/tmp/**',
  '.mpl/temp/**',
  '.mpl/draft/**',
  '.mpl/idea/**',
  '.mpl/jot/**',
  '.mpl/pivot-points-backup.md',
  '.mpl/working.md',
  '.mpl/runbook.md',
  '.mpl/mml/**',
]);

/**
 * Load and compile the channel registry from a `cfg` object (typically
 * the result of `loadConfig(cwd)`). When `cfg.channels` is missing or
 * its sub-arrays are empty OR contain only malformed entries, the
 * DEFAULT_* registries are used so the legacy / pre-Move-#7 callers
 * keep working.
 *
 * Note: the in-tree `yaml-mini` parser does not support flow-style
 * mappings (`{ key: value }`). The plan-spec YAML uses flow-style for
 * compactness; when that fails to parse into valid entries, this
 * loader falls back to DEFAULT_ALLOWED / DEFAULT_IMMUTABLE_WHEN /
 * DEFAULT_FORBIDDEN, which are byte-equivalent to the YAML's intended
 * content. A future yaml-mini upgrade can drop the hard-coded defaults
 * and read everything from the file.
 *
 * The returned object is fully pre-compiled — each entry carries its
 * RegExp list so per-write classification is a simple `regex.test`.
 */
export function loadChannelRegistry(cfg) {
  const channels = (cfg && typeof cfg === 'object' && cfg.channels && typeof cfg.channels === 'object')
    ? cfg.channels
    : {};

  // For each section, prefer the parsed value when it's a non-empty
  // array AND contains at least one valid entry. Otherwise fall back to
  // the hard-coded DEFAULT_*.

  const parsedAllowed = Array.isArray(channels.allowed)
    ? channels.allowed.filter((e) => e && typeof e.path === 'string')
    : [];
  const allowedSource = parsedAllowed.length > 0 ? parsedAllowed : DEFAULT_ALLOWED;

  const parsedImmutable = Array.isArray(channels.immutable_when)
    ? channels.immutable_when.filter((e) => e && typeof e.match === 'string' && typeof e.when === 'string')
    : [];
  const immutableSource = parsedImmutable.length > 0 ? parsedImmutable : DEFAULT_IMMUTABLE_WHEN;

  const parsedForbidden = Array.isArray(channels.forbidden_patterns)
    ? channels.forbidden_patterns.filter((p) => typeof p === 'string')
    : [];
  const forbiddenSource = parsedForbidden.length > 0 ? parsedForbidden : DEFAULT_FORBIDDEN;

  const allowed = allowedSource.map((e) => ({
    ...e,
    regexes: compileGlob(e.path),
  }));

  const immutableWhen = immutableSource.map((e) => ({
    ...e,
    regexes: compileGlob(e.match),
  }));

  const forbidden = forbiddenSource.map((p) => ({
    pattern: p,
    regexes: compileGlob(p),
  }));

  return { allowed, immutableWhen, forbidden };
}

// ============================================================================
// Per-policy primitives (exported for tests + sub-callers)
// ============================================================================

/**
 * Find the first allowed channel entry that matches `relPath`, or null.
 * `relPath` MUST be a workspace-relative posix path (caller normalizes).
 */
export function matchAllowedChannel(relPath, registry) {
  if (!relPath || !registry || !Array.isArray(registry.allowed)) return null;
  for (const entry of registry.allowed) {
    if (anyRegexMatches(entry.regexes, relPath)) return entry;
  }
  return null;
}

/**
 * Find the first forbidden-pattern entry that matches `relPath`, or null.
 */
export function matchForbiddenPattern(relPath, registry) {
  if (!relPath || !registry || !Array.isArray(registry.forbidden)) return null;
  for (const entry of registry.forbidden) {
    if (anyRegexMatches(entry.regexes, relPath)) return entry;
  }
  return null;
}

/**
 * Classify a workspace-relative path against the registry. Returns one of:
 *   { kind: 'forbidden', pattern }
 *   { kind: 'allowed',   entry, captures }
 *   { kind: 'outside_mpl' }                    — path is not under .mpl/
 *   { kind: 'unregistered_channel' }           — under .mpl/, no match
 */
export function classifyChannel(relPath, registry) {
  const normalized = normalizePosixPath(relPath);
  if (!normalized) return { kind: 'outside_mpl' };

  // forbidden FIRST — explicit denylist beats everything.
  const forbid = matchForbiddenPattern(normalized, registry);
  if (forbid) return { kind: 'forbidden', pattern: forbid.pattern };

  // Outside .mpl/ → not in scope for this registry.
  if (!normalized.startsWith('.mpl/') && normalized !== '.mpl') {
    return { kind: 'outside_mpl' };
  }

  // allowed match.
  for (const entry of registry.allowed || []) {
    for (const re of entry.regexes) {
      const m = re.exec(normalized);
      if (m) {
        const captures = (m.groups && Object.keys(m.groups).length > 0)
          ? { ...m.groups }
          : {};
        return { kind: 'allowed', entry, captures };
      }
    }
  }

  return { kind: 'unregistered_channel' };
}

// ============================================================================
// Immutability evaluators
// ============================================================================

function isEditTool(toolName) {
  return ['Edit', 'MultiEdit', 'edit', 'multiEdit', 'multiedit'].includes(
    String(toolName || ''),
  );
}

function buildBaselineBlock({ relPath }) {
  const reason = [
    `[MPL Baseline Guard] Blocked write to ${BASELINE_FILE}.`,
    '',
    'This file is the immutable ground-truth snapshot recorded at Step 2.9 after',
    'Stage 2 Ambiguity Resolution closed. Downstream consumers (Decomposer,',
    `Seed Generator, 4.7 Partial Rollback) treat it as the pipeline's baseline.`,
    'Silently overwriting it would corrupt delta calculation and rollback.',
    '',
    'To legitimately rewrite the baseline (Phase 0 re-interview), drop the',
    'renewal sentinel first:',
    '',
    `  touch ${RENEWAL_FLAG_FILE}`,
    '',
    'Then retry the write. The orchestrator removes the flag after successful',
    'baseline rewrite.',
  ].join('\n');
  return {
    action: 'block',
    code: 'baseline_immutable',
    reason,
    artifact: BASELINE_FILE,
    resumeInstruction:
      `Create the renewal sentinel (${RENEWAL_FLAG_FILE}), retry the baseline write, then let the orchestrator remove the sentinel after the rewrite succeeds.`,
    retryContext: {
      target: BASELINE_FILE,
      renewal_flag: RENEWAL_FLAG_FILE,
      requested_targets: [relPath],
    },
  };
}

function evalBaselineRenewalSentinelAbsent({ relPath, cwd }) {
  // Baseline does not yet exist → first write is allowed.
  if (!baselineExists(cwd)) return { action: 'allow' };
  // Baseline exists → allow only when renewal sentinel is present.
  if (renewalAuthorized(cwd)) return { action: 'allow' };
  return buildBaselineBlock({ relPath });
}

function evalAlwaysAfterFirstWrite({ relPath, cwd }) {
  const abs = resolvePath(cwd || '.', relPath);
  if (!existsSync(abs)) return { action: 'allow' };
  return {
    action: 'block',
    code: 'channel_immutable',
    reason:
      `[MPL Channel Registry] ${relPath} is immutable after the first write. ` +
      'Append-only / single-write contract violated.',
    artifact: relPath,
    resumeInstruction:
      `Do not overwrite ${relPath}; if a true rewrite is intended, follow the documented renewal procedure for this artifact.`,
    retryContext: { target: relPath },
  };
}

function evalAlways({ relPath }) {
  return {
    action: 'block',
    code: 'channel_immutable',
    reason:
      `[MPL Channel Registry] ${relPath} is unconditionally immutable per ` +
      'the channel registry.',
    artifact: relPath,
    resumeInstruction: `Do not write ${relPath}.`,
    retryContext: { target: relPath },
  };
}

function evalCompletedPhaseBlockUnchanged({
  relPath, oldText, newText, state, cwd, cfg, toolName,
}) {
  // Honor existing opt-out config flag (parity with legacy hook).
  if (cfg?.completed_phase_immutability_required === false) {
    return { action: 'allow' };
  }
  const completedIds = completedPhaseIds(cwd, state || {});
  if (completedIds.length === 0) return { action: 'allow' };

  // partial-edit special-case: Edit/MultiEdit on decomposition.yaml with
  // completed phases is always blocked (cannot diff a partial patch
  // against canonical YAML).
  const issues = [];
  if (isEditTool(toolName)) {
    issues.push('decomposition:partial_edit_not_allowed_with_completed_phases');
  } else {
    if (typeof newText !== 'string' || !newText.trim()) {
      issues.push('decomposition:empty_write');
    } else {
      const verdict = validateCompletedPhaseImmutability({
        oldText: oldText || '',
        newText,
        completedIds,
      });
      issues.push(...verdict.issues);
    }
  }

  if (issues.length === 0) return { action: 'allow' };

  const shown = issues.slice(0, 12).join(', ');
  const more = issues.length > 12 ? ` (+${issues.length - 12} more)` : '';
  return {
    action: 'block',
    code: 'completed_phase_mutation',
    ruleId: 'missing_completed_phase_immutability',
    reason:
      `[MPL Completed Phase Immutability] Completed phase contract blocks are ` +
      `immutable during recomposition: ${shown}${more}. ` +
      'Append new phases or modify only incomplete phases.',
    artifact: relPath,
    resumeInstruction:
      'Rewrite decomposition.yaml so completed phase blocks are unchanged; only append or modify incomplete phases, then retry the write.',
    retryContext: {
      issues: issues.slice(0, 50),
      completed_ids: completedIds,
    },
  };
}

function statusForPhaseId(state, phaseId) {
  const details = state?.execution?.phase_details;
  if (!Array.isArray(details)) return null;
  const entry = details.find((d) => d && d.id === phaseId);
  return entry?.status ?? null;
}

function evalPhaseLifecycleCompleted({
  relPath, state, cfg, captures, rule,
}) {
  // Honor enforcement gate so operators with `off` are opted out.
  if (cfg?.completed_phase_immutability_required === false) {
    return { action: 'allow' };
  }
  let phaseId = captures?.phase_id || null;
  // The `phase-*` glob capture extracts the SUFFIX (e.g. `2` from
  // `phase-2`). The state phase_details list keys on the full `phase-N`
  // form, so prefix when the capture has no prefix already.
  if (phaseId && !phaseId.startsWith('phase-')) {
    phaseId = `phase-${phaseId}`;
  }
  if (!phaseId && rule?.applies_to === 'contract_phase_id') {
    // Parse phase id from contract filename `.mpl/contracts/phase-<N>*.json`.
    const m = relPath.match(/\.mpl\/contracts\/(phase-[\w.-]+?)(?:[._-][^/]*)?\.json$/);
    if (m) phaseId = m[1];
  }
  if (!phaseId) return { action: 'allow' };

  const status = statusForPhaseId(state, phaseId);
  if (status !== 'completed') return { action: 'allow' };

  return {
    action: 'block',
    code: 'completed_phase_artifact_mutation',
    ruleId: 'missing_completed_phase_immutability',
    reason:
      `Phase ${phaseId} is completed; its artifacts are immutable until ` +
      'decomposition delta authorizes new attempts.',
    artifact: relPath,
    resumeInstruction:
      `Open a decomposition delta authorizing a new attempt for ${phaseId}, ` +
      'then retry; do not overwrite a completed phase artifact directly.',
    retryContext: {
      target: relPath,
      phase_id: phaseId,
      rule_match: rule?.match,
      when: rule?.when,
      captures: captures || {},
    },
  };
}

const EVALUATORS = {
  'always': evalAlways,
  'always_after_first_write': evalAlwaysAfterFirstWrite,
  'baseline_renewal_sentinel_absent': evalBaselineRenewalSentinelAbsent,
  'completed_phase_block_unchanged': evalCompletedPhaseBlockUnchanged,
  'phase_lifecycle.phase_id_completed': evalPhaseLifecycleCompleted,
};

/**
 * Evaluate all immutability rules that match `relPath`. Returns the
 * FIRST blocking verdict (in registry order), or `{action: 'allow'}` if
 * every matching rule allows. Also returns the matched rule metadata
 * for diagnostic surfaces.
 */
export function evaluateImmutability({
  relPath, oldText, newText, state, cwd, cfg, toolName, registry, focusRules,
}) {
  if (!registry || !Array.isArray(registry.immutableWhen)) {
    return { action: 'allow' };
  }

  for (const rule of registry.immutableWhen) {
    if (focusRules && Array.isArray(focusRules) && !focusRules.includes(rule.when)) continue;
    const m = anyRegexMatches(rule.regexes, relPath);
    if (!m) continue;
    const captures = (m.groups && Object.keys(m.groups).length > 0)
      ? { ...m.groups }
      : {};

    const evaluator = EVALUATORS[rule.when];
    if (typeof evaluator !== 'function') continue;

    const verdict = evaluator({
      relPath,
      oldText,
      newText,
      state,
      cwd,
      cfg,
      toolName,
      captures,
      rule,
    });
    if (verdict && verdict.action === 'block') {
      return {
        ...verdict,
        retryContext: {
          ...(verdict.retryContext || {}),
          rule_match: rule.match,
          when: rule.when,
          captures,
        },
      };
    }
  }
  return { action: 'allow' };
}

// ============================================================================
// Top-level entrypoint — evaluateChannelWrite
// ============================================================================

/**
 * Top-level channel-registry policy entrypoint.
 *
 * Decision priority (per Move #7 plan):
 *   1. forbidden patterns  → block(unregistered_channel)
 *   2. immutability rules  → first blocking verdict wins
 *   3. allowlist           → entry classification (allow OR
 *                            unregistered_channel)
 *   4. schema validation   → when entry has `schema:` and PostToolUse
 *
 * @param {object} params
 * @param {string} params.cwd
 * @param {object} params.state
 * @param {object} params.cfg
 * @param {string} params.relPath           workspace-relative path
 * @param {string} [params.oldText]
 * @param {string} [params.newText]
 * @param {string} [params.toolName]
 * @param {string} [params.hookEvent]       'PreToolUse' | 'PostToolUse'
 * @param {{categories?: string[], rules?: string[], runSchema?: boolean,
 *          runAllowlist?: boolean, runImmutability?: boolean,
 *          runForbidden?: boolean}} [params.focus]
 *   Narrows which rule slices activate. When omitted, the full registry
 *   runs (CLI mode + future consolidated single-hook).
 *
 * @returns {{
 *   action: 'allow' | 'block',
 *   code?: string,
 *   reason?: string,
 *   ruleId?: string,
 *   artifact?: string,
 *   resumeInstruction?: string,
 *   retryContext?: object,
 *   classification?: {kind: string, entry?: object, pattern?: string, captures?: object},
 * }}
 */
export function evaluateChannelWrite({
  cwd,
  state,
  cfg,
  relPath,
  oldText,
  newText,
  toolName,
  hookEvent,
  focus,
}) {
  const registry = loadChannelRegistry(cfg);
  const normalized = normalizePosixPath(relPath);

  const focusCategories = focus?.categories;
  const focusRules = focus?.rules;
  const runForbidden = focus?.runForbidden !== false;
  const runAllowlist = focus?.runAllowlist !== false;
  const runImmutability = focus?.runImmutability !== false;
  const runSchema = focus?.runSchema !== false;

  const classification = classifyChannel(normalized, registry);

  // ---- (1) forbidden / unregistered channel ----------------------------
  // Honor categories focus only when the path classifies as 'allowed'
  // (so we can check category match). For 'forbidden' / 'unregistered',
  // these are gates the shim opted-in to via runForbidden / runAllowlist.
  if (runForbidden && classification.kind === 'forbidden') {
    return {
      action: 'block',
      code: 'forbidden_channel',
      reason:
        `[MPL Channel Registry] Path ${normalized} matches forbidden pattern ` +
        `"${classification.pattern}". Anti-pattern channels (scratchpad / ` +
        'notes / tmp / draft / runbook duplicate) are not allowed under .mpl/.',
      artifact: normalized,
      resumeInstruction:
        `Move the content to an allowed channel (see channels.allowed in ` +
        'mpl.config.yaml) and retry, OR remove the write entirely.',
      retryContext: {
        target: normalized,
        forbidden_pattern: classification.pattern,
      },
      classification,
    };
  }

  if (runAllowlist && classification.kind === 'unregistered_channel') {
    return {
      action: 'block',
      code: 'unregistered_channel',
      reason:
        `[MPL Channel Registry] Path ${normalized} is under .mpl/ but does ` +
        'not match any registered channel in channels.allowed. ' +
        'Either register a new channel in mpl.config.yaml or use one of ' +
        'the existing allowed paths.',
      artifact: normalized,
      resumeInstruction:
        `Register ${normalized} as a channel in mpl.config.yaml ` +
        '(channels.allowed[]) or pick an existing allowed path, then retry.',
      retryContext: { target: normalized },
      classification,
    };
  }

  // If focus is restricted by category, only proceed when the matching
  // allowed entry's category is in the focus set. This lets the per-hook
  // shims activate only their slice of the registry.
  if (focusCategories && Array.isArray(focusCategories) && focusCategories.length > 0) {
    if (classification.kind === 'allowed') {
      const cat = classification.entry?.category;
      if (cat && !focusCategories.includes(cat)) {
        return { action: 'allow', classification };
      }
    } else if (classification.kind === 'outside_mpl') {
      return { action: 'allow', classification };
    }
  }

  // ---- (2) immutability ------------------------------------------------
  if (runImmutability && classification.kind !== 'outside_mpl') {
    const immVerdict = evaluateImmutability({
      relPath: normalized,
      oldText,
      newText,
      state,
      cwd,
      cfg,
      toolName,
      registry,
      focusRules,
    });
    if (immVerdict.action === 'block') {
      return { ...immVerdict, classification };
    }
  }

  // ---- (3) schema validation (PostToolUse only) ------------------------
  if (
    runSchema &&
    hookEvent === 'PostToolUse' &&
    classification.kind === 'allowed' &&
    classification.entry?.schema &&
    typeof newText === 'string' &&
    newText.length > 0
  ) {
    if (matchArtifactSchema(normalized)) {
      const verdict = validateArtifactFile(normalized, newText, { cwd });
      if (verdict && !verdict.valid) {
        const parts = [];
        if (verdict.missing.length > 0) {
          parts.push(`missing required: ${verdict.missing.join(', ')}`);
        }
        if (verdict.missingAnyOf.length > 0) {
          const groups = verdict.missingAnyOf.map((g) => `(any of: ${g.join(' | ')})`);
          parts.push(`missing one-of: ${groups.join('; ')}`);
        }
        return {
          action: 'block',
          code: 'missing_artifact_schema',
          ruleId: 'missing_artifact_schema',
          reason:
            `[MPL Channel Registry] Artifact schema violation: ${normalized}: ` +
            `${parts.join('; ') || 'unknown'}. Re-emit the artifact with the ` +
            'required sections.',
          artifact: normalized,
          resumeInstruction:
            'Re-emit the blocked artifact with the required schema sections, overwriting the invalid version, then retry the next MPL step.',
          retryContext: {
            artifact: verdict.artifact,
            file: verdict.relPath,
            missing: verdict.missing,
            missing_any_of: verdict.missingAnyOf,
          },
          classification,
        };
      }
    }
  }

  return { action: 'allow', classification };
}

// ============================================================================
// CLI re-use — preserves the existing artifact-schema CLI mode
// ============================================================================

/**
 * Walk the workspace, collect every existing path under an allowed
 * channel that has `schema:` declared, and run the artifact-schema
 * validator over it. Output: `{ totals: {files, valid, invalid},
 * results: [...] }`. Exits 1 when any file is invalid, 0 otherwise, 2
 * when the workspace root does not exist.
 *
 * This is the same contract finalize Step 5 + doctor Category 6
 * consume, simply backed by the channel registry now instead of a
 * hardcoded `enumerateArtifactPaths()` switch.
 */
export function runChannelRegistryCli(workspaceRoot, {
  readFileSync, readdirSync, existsSync: existsSyncOpt, loadConfig: loadConfigOpt,
} = {}) {
  // Lazy imports so the module stays import-pure when consumed as a lib.
  /* eslint-disable global-require */
  const fs = { readFileSync, readdirSync, existsSync: existsSyncOpt };
  const _loadConfig = loadConfigOpt;
  return _runCli(workspaceRoot, fs, _loadConfig);
}

function _runCli(workspaceRoot, fs, _loadConfig) {
  const root = resolvePath(workspaceRoot);
  if (!fs.existsSync(root)) {
    process.stderr.write(`[mpl-channel-registry] workspace root not found: ${root}\n`);
    process.exit(2);
  }
  const cfg = _loadConfig ? _loadConfig(root) : {};
  const registry = loadChannelRegistry(cfg);

  // Collect every allowed entry that declares a schema and exists on disk.
  const candidates = collectSchemaBoundPaths(root, registry, fs);
  const results = [];
  for (const rel of candidates) {
    const abs = resolvePath(root, rel);
    let content;
    try { content = fs.readFileSync(abs, 'utf-8'); }
    catch { continue; }
    const verdict = validateArtifactFile(rel, content, { cwd: root });
    if (!verdict) continue;
    results.push({
      artifact: verdict.artifact,
      file: rel,
      valid: verdict.valid,
      missing: verdict.missing,
      missing_any_of: verdict.missingAnyOf,
    });
  }
  const totals = {
    files: results.length,
    valid: results.filter((r) => r.valid).length,
    invalid: results.filter((r) => !r.valid).length,
  };
  process.stdout.write(JSON.stringify({ totals, results }, null, 2) + '\n');
  process.exit(totals.invalid > 0 ? 1 : 0);
}

function collectSchemaBoundPaths(root, registry, fs) {
  const out = [];
  const seen = new Set();
  const allowedWithSchema = (registry.allowed || []).filter((e) => e.schema);

  for (const entry of allowedWithSchema) {
    // Try literal path first.
    const literal = entry.path;
    if (!literal.includes('*') && !literal.includes('{')) {
      if (fs.existsSync(resolvePath(root, literal))) {
        if (!seen.has(literal)) { seen.add(literal); out.push(literal); }
      }
      continue;
    }
    // For glob entries with `phase-*`, enumerate phase folders.
    if (literal.startsWith('.mpl/mpl/phases/phase-*/')) {
      const phasesDir = resolvePath(root, '.mpl/mpl/phases');
      if (!fs.existsSync(phasesDir)) continue;
      let entries = [];
      try { entries = fs.readdirSync(phasesDir, { withFileTypes: true }); } catch {}
      const suffix = literal.slice('.mpl/mpl/phases/phase-*/'.length);
      for (const dirent of entries) {
        if (!dirent.isDirectory()) continue;
        if (!/^phase-/.test(dirent.name)) continue;
        const candidate = `.mpl/mpl/phases/${dirent.name}/${suffix}`;
        if (fs.existsSync(resolvePath(root, candidate)) && !seen.has(candidate)) {
          seen.add(candidate);
          out.push(candidate);
        }
      }
    }
    // Other glob shapes with schema: register on demand (none in default
    // set today — goal-contract / pivot-points / user-contract are
    // literal paths).
  }
  return out;
}
