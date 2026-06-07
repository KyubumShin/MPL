#!/usr/bin/env node
/**
 * MPL Require Covers Hook — thin wrapper around policy/contracts.handleCovers.
 *
 * Structural decision (Tier B `covers` schema validation on
 * `.mpl/mpl/decomposition.yaml` writes) is delegated to
 * `lib/policy/contracts.handleCovers`. This wrapper preserves the legacy
 * stdout shape, blocked-hook envelope writes, and the local warn-on-high-
 * internal-ratio side effect that the policy module intentionally does
 * not own (warns are not structural decisions).
 *
 * Named exports `targetsDecompositionFile`, `parsePhaseCovers`,
 * `validatePhase`, `computeInternalRatio`, `loadWarnThreshold`,
 * `isLegacyMode` remain available for the existing unit tests.
 *
 * For emergency rollback the original implementation lives at
 *   hooks/mpl-require-covers.legacy.mjs
 *
 * Non-blocking on any error.
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync, readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { isFileWriteTool } = await import(
  pathToFileURL(join(__dirname, 'lib', 'tool-input.mjs')).href
);
const { recordBlockedHook, clearBlockedHook } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-blocked-hook.mjs')).href
);
const { handleCovers } = await import(
  pathToFileURL(join(__dirname, 'lib', 'policy', 'contracts.mjs')).href
);

const DEFAULT_WARN_THRESHOLD = 0.4;
const UC_ID_RE = /^UC-\d{2,}$/;
const HOOK_ID = 'mpl-require-covers';
const BLOCKED_ARTIFACT = '.mpl/mpl/decomposition.yaml';

// ----------------------------------------------------------------------------
// Named exports preserved for the existing unit test surface.
// (Logic mirrors the legacy hook 1:1; the policy module owns the structural
// allow/block decision but the parser/validator/ratio helpers remain here so
// callers and tests keep their import contract.)
// ----------------------------------------------------------------------------

export function targetsDecompositionFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  return /(^|\/)\.mpl\/mpl\/decomposition\.yaml$/.test(filePath);
}

export function parsePhaseCovers(yamlText) {
  if (!yamlText || typeof yamlText !== 'string') return [];
  const lines = yamlText.split('\n').map((l) => l.replace(/\r$/, ''));
  const phases = [];
  let cur = null;
  let inCovers = false;
  let coversIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const phaseMatch = line.match(/^\s*-\s+id:\s*["']?(phase-[\w-]+)["']?/);
    if (phaseMatch) {
      if (cur) phases.push(cur);
      cur = { id: phaseMatch[1], covers: null };
      inCovers = false;
      continue;
    }
    if (!cur) continue;
    const inlineMatch = line.match(/^(\s*)covers\s*:\s*\[(.*)\]\s*$/);
    if (inlineMatch) {
      cur.covers = inlineMatch[2]
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
      inCovers = false;
      continue;
    }
    const blockMatch = line.match(/^(\s*)covers\s*:\s*$/);
    if (blockMatch) {
      coversIndent = blockMatch[1].length;
      cur.covers = [];
      inCovers = true;
      continue;
    }
    if (inCovers) {
      const itemMatch = line.match(/^(\s*)-\s+["']?([^"'\s#]+)["']?/);
      if (itemMatch && itemMatch[1].length > coversIndent) {
        cur.covers.push(itemMatch[2]);
        continue;
      }
      if (line.trim() !== '' && !line.startsWith(' '.repeat(coversIndent + 1))) {
        inCovers = false;
      }
    }
  }
  if (cur) phases.push(cur);
  return phases;
}

export function validatePhase(phase, { allowLegacy }) {
  const issues = [];
  if (phase.covers === null) {
    issues.push({ kind: 'missing', phase: phase.id });
    return issues;
  }
  if (!Array.isArray(phase.covers) || phase.covers.length === 0) {
    issues.push({ kind: 'empty', phase: phase.id });
    return issues;
  }
  for (const entry of phase.covers) {
    if (entry === 'internal') continue;
    if (UC_ID_RE.test(entry)) continue;
    issues.push({ kind: 'invalid_entry', phase: phase.id, entry });
  }
  if (allowLegacy) return issues.filter((i) => i.kind !== 'invalid_entry');
  return issues;
}

export function computeInternalRatio(phases) {
  const total = phases.filter(
    (p) => Array.isArray(p.covers) && p.covers.length > 0,
  ).length;
  if (total === 0) return 0;
  const internalOnly = phases.filter(
    (p) =>
      Array.isArray(p.covers) &&
      p.covers.length > 0 &&
      p.covers.every((c) => c === 'internal'),
  ).length;
  return internalOnly / total;
}

export function loadWarnThreshold(cwd) {
  const path = join(cwd, '.mpl', 'config.json');
  if (!existsSync(path)) return DEFAULT_WARN_THRESHOLD;
  try {
    const cfg = JSON.parse(readFileSync(path, 'utf-8'));
    const t = cfg.internal_todo_warn_threshold;
    if (typeof t === 'number' && t > 0 && t <= 1) return t;
  } catch { /* fall through */ }
  return DEFAULT_WARN_THRESHOLD;
}

export function isLegacyMode(cwd) {
  const path = join(cwd, '.mpl', 'requirements', 'user-contract.md');
  return !existsSync(path);
}

// ----------------------------------------------------------------------------
// CLI entrypoint — delegating wrapper.
// ----------------------------------------------------------------------------

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;

if (isMain) {
  const { readStdin } = await import(
    pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
  );

  const ok = () =>
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  const okWithWarn = (msg) =>
    console.log(
      JSON.stringify({
        continue: true,
        suppressOutput: false,
        systemMessage: msg,
      }),
    );
  const block = (reason) =>
    console.log(JSON.stringify({ continue: false, decision: 'block', reason }));

  try {
    const raw = await readStdin();
    if (!raw) { ok(); process.exit(0); }

    let input;
    try { input = JSON.parse(raw); } catch { ok(); process.exit(0); }

    const toolName = input.tool_name || input.toolName || '';
    if (!isFileWriteTool(toolName)) { ok(); process.exit(0); }

    const rawToolInput = input.tool_input || {};
    const cwd = input.cwd || process.cwd();

    // Normalize MultiEdit: the policy collector pairs each edit's text with
    // its own `file_path` only, but MultiEdit carries `file_path` at the top
    // level. Propagate it onto every edit so the policy sees the writes.
    const parentFp = rawToolInput.file_path || rawToolInput.filePath || null;
    const toolInput = Array.isArray(rawToolInput.edits) && parentFp
      ? {
          ...rawToolInput,
          edits: rawToolInput.edits.map((e) => ({
            ...(e || {}),
            file_path: (e && (e.file_path || e.filePath)) || parentFp,
          })),
        }
      : rawToolInput;

    // Read workspace config (best-effort) so the policy module can honor
    // any `contracts.coverage.required: false` opt-out a workspace sets.
    let config = {};
    try {
      const cfgPath = join(cwd, '.mpl', 'config.json');
      if (existsSync(cfgPath)) config = JSON.parse(readFileSync(cfgPath, 'utf-8')) || {};
    } catch { /* non-blocking */ }

    const decision = await handleCovers({
      cwd,
      toolName,
      toolInput,
      config,
      hookEvent: input.hook_event_name || 'PreToolUse',
      state: input.state || {},
    });

    if (decision && decision.action === 'block') {
      const reason = decision.reason || 'Tier B schema violation in decomposition.yaml.';
      const retryContext = {
        // Preserve the legacy `target` companion that downstream consumers
        // (recover skill, state-invariant guard) rely on.
        target: BLOCKED_ARTIFACT,
        ...(decision.retryContext || {}),
      };
      recordBlockedHook(cwd, {
        hookId: HOOK_ID,
        artifact: decision.artifact || BLOCKED_ARTIFACT,
        code: decision.code || 'covers_schema_violation',
        reason,
        resumeInstruction:
          decision.resumeInstruction ||
          'Add a non-empty covers list to every phase using UC-NN ids or "internal", then retry the decomposition write.',
        retryContext,
      });
      block(reason);
      process.exit(0);
    }

    // Allow: clear any stale blocked envelope this hook owns…
    clearBlockedHook(cwd, { hookId: HOOK_ID, artifact: BLOCKED_ARTIFACT });

    // …then preserve the legacy warn-on-high-internal-ratio side effect.
    // The policy module deliberately does not own this (it is advisory, not
    // a structural decision). Recompute locally from the same texts the
    // policy inspected so the user-visible behavior is unchanged.
    const texts = [];
    const pushText = (fp, t) => {
      if (typeof fp === 'string' && targetsDecompositionFile(fp) && typeof t === 'string') {
        texts.push(t);
      }
    };
    pushText(
      toolInput.file_path || toolInput.filePath,
      toolInput.content || toolInput.new_string || toolInput.newString,
    );
    if (Array.isArray(toolInput.edits)) {
      for (const e of toolInput.edits) {
        pushText(
          e?.file_path || e?.filePath,
          e?.content || e?.new_string || e?.newString,
        );
      }
    }
    const phases = texts.flatMap((t) => parsePhaseCovers(t));
    if (phases.length > 0) {
      const threshold = loadWarnThreshold(cwd);
      const ratio = computeInternalRatio(phases);
      if (ratio > threshold) {
        okWithWarn(
          `[MPL Tier B] internal-only phases ${(ratio * 100).toFixed(0)}% > threshold ${(threshold * 100).toFixed(0)}%. ` +
            `Consider whether more phases could covers a user UC. Override via .mpl/config.json internal_todo_warn_threshold.`,
        );
        process.exit(0);
      }
    }
    ok();
  } catch {
    ok();
  }
}
