/**
 * MPL Source-Edit Policy (L2 module — Move #6)
 *
 * Owns the entire source-edit decision graph end-to-end across BOTH the
 * Edit/Write/MultiEdit/NotebookEdit AND Bash tool surfaces.
 *
 * The wrapper hook (hooks/mpl-write-guard.mjs) is now a thin shim: it
 * reads stdin, builds an `event`, calls `handle()`, serializes the
 * returned decision envelope into the JSON the engine expects, and
 * applies the structured `sideEffects` (recordBlockedHook / clearBlockedHook
 * / lockDecomposerChild / recordDecomposerDispatch / recordFirstTranscript)
 * in order.
 *
 * Dependency boundary (per hooks/lib/policy/README.md):
 *   - imports ONLY from `lib/mpl-enforcement.mjs`, `lib/mpl-config.mjs`,
 *     `lib/mpl-state.mjs`, `lib/mpl-blocked-hook.mjs`, and
 *     `lib/mpl-decomposition-parser.mjs`.
 *   - NEVER imports another `policy/*.mjs`.
 *
 * Move #6 closes the "Bash bypass" gap that let
 *   `printf x > src/app.ts` / `tee src/app.ts < /tmp/forged` / etc.
 * sneak past the Edit/Write direct_source_edit gate. The new
 * `extractBashWriteTargets()` finds every Bash write-target shape
 * (redirects, tee, sed -i, dd of=, cp/mv/install/rsync, interpreter
 * one-liners, touch, sponge, formatters, patch / git apply / git
 * restore, archive extracts) and runs the same isSourceFile +
 * isAllowedPath gates as the Edit/Write branch.
 */

import { extname, dirname, join, resolve as resolvePath, basename, posix as posixPath } from 'path';
import { existsSync, realpathSync } from 'fs';

import { loadConfig } from '../mpl-config.mjs';
import { resolveRuleAction } from '../mpl-enforcement.mjs';
import { readState } from '../mpl-state.mjs';
import { getPhaseScope } from '../mpl-decomposition-parser.mjs';

// =============================================================================
// Constants and small helpers
// =============================================================================

const HOOK_ID = 'mpl-write-guard';

// File-path normalization — collapses `//` and `/./` segments before regex.
// Mirrors mpl-write-guard.mjs:23-26 verbatim.
export function normalizeFilePath(p) {
  if (typeof p !== 'string' || !p) return p;
  return posixPath.normalize(p);
}

// Decomposition file regex (case-insensitive — APFS/NTFS case-fold).
export const DECOMPOSITION_FILE_REGEX = /(^|\/)\.mpl\/mpl\/decomposition\.ya?ml$/i;
export const STATE_FILE_REGEX = /(^|\/)\.mpl\/state\.json$/i;
export const DECOMPOSER_DISPATCH_FIELD_REGEX = /"decomposer_dispatch"\s*:/;
export const FIRST_TRANSCRIPT_FIELD_REGEX = /"first_transcript_seen"\s*:/;

const DECOMPOSER_SUBAGENT_TYPES = new Set([
  'mpl-decomposer',
  'mpl:mpl-decomposer',
]);
const DECOMPOSER_DISPATCH_TTL_MS = 30 * 60 * 1000;

// Protected paths the mpl-cancel skill forbids deleting.
export const PROTECTED_DELETE_TARGETS = [
  '.mpl/mpl',
  '.mpl/contracts',
  '.mpl/memory',
  'docs/learnings',
];

// Dogfood mode toggle — `/MPL/` is allowed by default; suppressed in dogfood.
export const DOGFOOD_SUPPRESSED = /\/MPL\//;

export const ALLOWED_PATTERNS = [
  /\.mpl\//,
  /\.omc\//,
  /\.claude\//,
  /\/\.claude\//,
  DOGFOOD_SUPPRESSED,
  /PLAN\.md$/,
  /docs\/learnings\//,
];

// Source extensions. Notebook (.ipynb) added per Move #6 NotebookEdit support.
export const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyw',
  '.go', '.rs', '.java', '.kt', '.scala',
  '.c', '.cpp', '.cc', '.h', '.hpp',
  '.rb', '.php',
  '.svelte', '.vue',
  '.css', '.scss', '.less',
  '.html', '.htm',
  '.json', '.yaml', '.yml', '.toml',
  '.sql',
  '.sh', '.bash', '.zsh',
  '.ipynb',
]);

export const DANGEROUS_BASH_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force)/,
  /\bgit\s+push\s+.*--force/,
  /\bgit\s+reset\s+--hard/,
  /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i,
  /\bTRUNCATE\s+TABLE\b/i,
  /\bkubectl\s+delete\b/,
  /\bdocker\s+rm\s+(-[a-zA-Z]*f|--force)/,
  /\bdocker\s+system\s+prune/,
  /\bchmod\s+777\b/,
];

export const SAFE_CLEANUP_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force\s+)(\.\/)?node_modules/,
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force\s+)(\.\/)?\.next/,
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force\s+)(\.\/)?dist/,
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force\s+)(\.\/)?build/,
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force\s+)(\.\/)?\.cache/,
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force\s+)(\.\/)?coverage/,
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force\s+)(\.\/)?__pycache__/,
];

export function isDangerousBashCommand(command) {
  if (!command) return false;
  if (SAFE_CLEANUP_PATTERNS.some(p => p.test(command))) return false;
  return DANGEROUS_BASH_PATTERNS.some(p => p.test(command));
}

export function isDogfoodMode(cwd) {
  if (process.env.MPL_DOGFOOD === '1') return true;
  try {
    const cfg = loadConfig(cwd);
    return cfg?.dogfood === true;
  } catch {
    return false;
  }
}

export function isAllowedPath(filePath, opts = {}) {
  if (!filePath) return true;
  const { dogfood = false } = opts;
  return ALLOWED_PATTERNS.some((pattern) => {
    if (dogfood && pattern === DOGFOOD_SUPPRESSED) return false;
    return pattern.test(filePath);
  });
}

export function isSourceFile(filePath) {
  if (!filePath) return false;
  return SOURCE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

// =============================================================================
// Shell-normalization helpers (moved verbatim)
// =============================================================================

export function expandSimpleVars(text) {
  const vars = new Map();
  const segments = text.split(/(?:;|&&|\|\||\n)/);
  for (const seg of segments) {
    let s = seg.trimStart().replace(/^export\s+/, '');
    const m = s.match(/^([a-zA-Z_][a-zA-Z0-9_]*)=("([^"]*)"|'([^']*)'|(\S+))/);
    if (m) {
      const value = m[3] !== undefined ? m[3]
        : m[4] !== undefined ? m[4]
        : (m[5] ?? '');
      vars.set(m[1], value);
    }
  }
  if (vars.size === 0) return text;
  let out = text;
  for (const [name, value] of vars) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\$\\{${esc}\\}`, 'g'), value);
    out = out.replace(new RegExp(`\\$${esc}\\b`, 'g'), value);
  }
  return out;
}

export function expandShellBraces(text) {
  let tokens = text.split(/\s+/);
  for (let iter = 0; iter < 10; iter++) {
    let changed = false;
    const next = [];
    for (const t of tokens) {
      const m = t.match(/^([^{}]*)\{([^{}]+)\}(.*)$/);
      if (m && m[2].includes(',')) {
        const [, pre, body, post] = m;
        for (const p of body.split(',')) next.push(`${pre}${p}${post}`);
        changed = true;
      } else {
        next.push(t);
      }
    }
    tokens = next;
    if (!changed) break;
  }
  return tokens.join(' ');
}

export function normalizeShellCommand(command) {
  let normalized = command.replace(/^\s*(sudo|time|nice|env)\s+/, '').trim();
  normalized = normalized
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\U([0-9a-fA-F]{8})/g, (_, h) => {
      const cp = parseInt(h, 16);
      try { return String.fromCodePoint(cp); } catch { return ''; }
    })
    .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
    .replace(/\\([\s\S])/g, '$1')
    .replace(/["'`]/g, '')
    .replace(/\/+/g, '/')
    .replace(/\/(?:\.\/)+/g, '/');
  let prevNormalized;
  do {
    prevNormalized = normalized;
    normalized = normalized.replace(/\/[^/]+\/\.\.(?:\/|$)/g, '/');
  } while (normalized !== prevNormalized);
  normalized = expandShellBraces(normalized);
  normalized = expandSimpleVars(normalized);
  return normalized;
}

export function matchesProtectedDelete(command, cwd) {
  if (!command || typeof command !== 'string') return null;
  let normalized = normalizeShellCommand(command);
  const isDestructive = (
    /\brm\b/.test(normalized) ||
    /\bfind\b.*-delete\b/.test(normalized) ||
    /\bmv\b/.test(normalized) ||
    /\bshred\b/.test(normalized) ||
    /\bunlink\b/.test(normalized) ||
    /\btruncate\b/.test(normalized) ||
    /\bcp\b.*\/dev\/null/.test(normalized) ||
    /\btee\b/.test(normalized) ||
    /\bdd\b.*\bof=/.test(normalized) ||
    /\bln\b/.test(normalized) ||
    /\btar\b.*--remove-files\b/.test(normalized) ||
    /\brsync\b.*--remove-source-files\b/.test(normalized) ||
    /\brsync\b.*--delete(?:-before|-during|-delay|-after)?\b/.test(normalized) ||
    /\bgit\s+clean\b.*-\S*[xX]/.test(normalized) ||
    normalized.split(/[;|&\n]+/).some((seg) => {
      if (!/\b(gzip|bzip2|xz|zstd)\b/.test(seg)) return false;
      const tokens = seg.trim().split(/\s+/);
      let pastVerb = false;
      let hasKeep = false;
      for (const t of tokens) {
        if (!pastVerb) {
          if (/^(gzip|bzip2|xz|zstd)$/.test(t)) pastVerb = true;
          continue;
        }
        if (t === '--') break;
        if (
          t === '-k' ||
          t === '--keep' ||
          /^--keep=/.test(t) ||
          /^-[a-zA-Z]*k[a-zA-Z]*$/.test(t)
        ) {
          hasKeep = true;
          break;
        }
      }
      return !hasKeep;
    }) ||
    /\b(node|deno|bun|python\d?|ruby|perl|php|lua|tclsh|osascript|awk|sed)\b/.test(normalized) ||
    /(?:^|[\s;|&])\d?>{1,2}/.test(normalized) ||
    /(?:^|[\s;|&])&>{1,2}/.test(normalized)
  );
  if (!isDestructive) return null;

  for (const target of PROTECTED_DELETE_TARGETS) {
    if (normalized.includes(target)) return target;
  }

  const hasDecoder = /\bbase64\b|\bxxd\b|\bopenssl\s+base64\b/.test(normalized);
  const hasCmdSub = /\$\(|`/.test(normalized);
  if (hasDecoder && hasCmdSub) {
    return PROTECTED_DELETE_TARGETS[0];
  }

  if (/\bgit\s+clean\b.*-\S*[xX]/.test(normalized)) {
    return PROTECTED_DELETE_TARGETS[0];
  }

  const resolvedRoots = PROTECTED_DELETE_TARGETS.map((target) => ({
    target,
    abs: resolvePath(cwd, target),
  }));

  const tokens = normalized
    .split(/[\s;|&()<>]+/)
    .map((t) => t.replace(/^[\\$]+/, '').replace(/[\\)]+$/, ''))
    .filter(Boolean);

  for (const token of tokens) {
    if (token.startsWith('-')) continue;
    if (/^(rm|find|sudo|time|nice|env|cd|pushd|popd|mkdir|mv|shred|unlink|truncate|cp|export|tee|dd|tar|rsync|echo|cat|printf|ln)$/i.test(token)) continue;

    const globIdx = token.search(/[*?[]/);
    if (globIdx >= 0) {
      const literalPrefix = token.slice(0, globIdx);
      let absPrefix;
      try { absPrefix = resolvePath(cwd, literalPrefix); }
      catch { continue; }
      for (const { target, abs: rootAbs } of resolvedRoots) {
        if (
          absPrefix === rootAbs ||
          absPrefix.startsWith(rootAbs + '/') ||
          rootAbs.startsWith(absPrefix)
        ) return target;
      }
      continue;
    }

    let abs;
    try { abs = resolvePath(cwd, token); }
    catch { continue; }
    for (const { target, abs: rootAbs } of resolvedRoots) {
      const cwdAbs = resolvePath(cwd);
      if (
        abs === rootAbs ||
        abs.startsWith(rootAbs + '/') ||
        (rootAbs.startsWith(abs + '/') && (abs === cwdAbs || abs.startsWith(cwdAbs + '/')))
      ) return target;
    }
  }
  return null;
}

// =============================================================================
// Decomposer dispatch helpers (side effects deferred to caller)
// =============================================================================

export function isDecomposerDispatchActive(state, callerTranscriptPath) {
  const flag = state?.decomposer_dispatch;
  if (!flag || typeof flag.dispatched_at !== 'string') return false;
  const ts = Date.parse(flag.dispatched_at);
  if (Number.isNaN(ts)) return false;
  if ((Date.now() - ts) > DECOMPOSER_DISPATCH_TTL_MS) return false;
  const parent = typeof flag.parent_transcript_path === 'string'
    ? flag.parent_transcript_path
    : null;
  if (!parent) return false;
  if (!callerTranscriptPath || typeof callerTranscriptPath !== 'string') return false;
  if (callerTranscriptPath === parent) return false;
  const lockedChild = typeof flag.child_transcript_path === 'string'
    ? flag.child_transcript_path
    : null;
  if (lockedChild) return callerTranscriptPath === lockedChild;
  return true;
}

// =============================================================================
// extractBashWriteTargets — Move #6 core
// =============================================================================

const INTERPRETER_VERBS = /^(node|deno|bun|python[0-9]?|ruby|perl|php|lua|tclsh|osascript)$/;
const FORMATTER_VERBS = new Set([
  'prettier', 'eslint', 'black', 'isort', 'rustfmt', 'gofmt',
  'clang-format', 'autopep8', 'yapf', 'ruff', 'biome', 'dprint',
  'taplo', 'ktlint', 'scalafmt', 'stylua',
]);
const DEV_NULL_SINKS = new Set([
  '/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty', '/dev/zero',
]);

function isOpaqueToken(token) {
  if (!token) return false;
  // After normalizeShellCommand, surviving `$` indicates unresolved var,
  // surviving `(` indicates command substitution leftover.
  return token.includes('$') || token.includes('(');
}

function hasGlobMeta(token) {
  return /[*?[\]]/.test(token);
}

function pushTarget(out, payload) {
  const key = `${payload.source}::${payload.target}`;
  if (out._seen.has(key)) return;
  out._seen.add(key);
  out.push(payload);
}

function tokenize(segment) {
  // Whitespace tokenize. The normalizer already stripped quotes and
  // expanded vars + braces.
  return segment.trim().split(/\s+/).filter(Boolean);
}

function headVerbOf(segment) {
  const m = segment.trim().match(/^(\S+)/);
  if (!m) return '';
  // Strip env-var-prefix like `FOO=bar verb …` — pick the first non
  // `name=value` token.
  const tokens = tokenize(segment);
  for (const t of tokens) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue;
    return t.toLowerCase();
  }
  return m[1].toLowerCase();
}

/**
 * Extract every write target from a normalized shell command.
 *
 * Returns Array<{target, source, segment, opaque?}>.
 *
 * `source` is one of:
 *   'redirect' | 'tee' | 'sed-i' | 'dd-of' | 'cp-mv-dst' |
 *   'interpreter-write' | 'touch' | 'sponge' | 'formatter' |
 *   'patch' | 'git-apply' | 'archive-extract'
 *
 * `opaque: true` when the token contains unresolved `$VAR` / `$(…)` /
 * `` ` `` — we cannot statically resolve the destination, so the caller
 * downgrades to warn-only.
 *
 * Input MUST be the already-built `normalizedCommand` (the same string
 * the protected-delete + state.json gates inspect).
 */
export function extractBashWriteTargets(normalizedCommand) {
  const out = [];
  out._seen = new Set();
  if (!normalizedCommand || typeof normalizedCommand !== 'string') return out;

  const segments = normalizedCommand
    .split(/[|;&\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const segment of segments) {
    const headVerb = headVerbOf(segment);

    // (a) REDIRECT — `>FILE`, `>>FILE`, `&>FILE`, `1>FILE`, `2>FILE`,
    //                `exec >FILE`. We skip `2>&1` and process-sub `>(…)`.
    const redirectRe = /(?:\bexec\b\s+)?([\d]?)(>{1,2}|&>{1,2})\s*([^\s|;&]+)/g;
    for (const m of segment.matchAll(redirectRe)) {
      const operand = m[3];
      // Skip fd-dup `2>&1` form
      if (/^&\d/.test(operand)) continue;
      // Skip process substitution
      if (operand.startsWith('(')) continue;
      if (DEV_NULL_SINKS.has(operand)) continue;
      pushTarget(out, {
        target: operand,
        source: 'redirect',
        segment,
        opaque: isOpaqueToken(operand) || hasGlobMeta(operand),
      });
    }

    const tokens = tokenize(segment);

    // (b) TEE — every trailing positional after flags is a write target.
    const teeIdx = tokens.findIndex((t) => t === 'tee');
    if (teeIdx >= 0) {
      for (let i = teeIdx + 1; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.startsWith('-')) continue;
        if (t.startsWith('(')) continue;
        if (DEV_NULL_SINKS.has(t)) continue;
        pushTarget(out, {
          target: t,
          source: 'tee',
          segment,
          opaque: isOpaqueToken(t) || hasGlobMeta(t),
        });
      }
    }

    // (c) DD of=
    const ddIdx = tokens.findIndex((t) => t === 'dd');
    if (ddIdx >= 0) {
      for (const t of tokens) {
        const m = t.match(/^of=(.+)$/);
        if (!m) continue;
        const target = m[1];
        if (DEV_NULL_SINKS.has(target)) continue;
        pushTarget(out, {
          target,
          source: 'dd-of',
          segment,
          opaque: isOpaqueToken(target) || hasGlobMeta(target),
        });
      }
    }

    // (d) SED -i / --in-place
    const sedIdx = tokens.findIndex((t) => t === 'sed');
    if (sedIdx >= 0) {
      let inPlace = false;
      for (let i = sedIdx + 1; i < tokens.length; i++) {
        const t = tokens[i];
        if (t === '-i' || t === '--in-place' || t.startsWith('--in-place=') ||
            /^-i[^-]/.test(t) || /^-[a-zA-Z]*i[a-zA-Z]*$/.test(t)) {
          inPlace = true;
          break;
        }
      }
      if (inPlace) {
        // Collect positional targets after script. -e / -f take an arg.
        let i = sedIdx + 1;
        let consumeNext = false;
        while (i < tokens.length) {
          const t = tokens[i];
          if (consumeNext) { consumeNext = false; i++; continue; }
          if (t === '-e' || t === '--expression' || t === '-f' || t === '--file') {
            consumeNext = true;
            i++;
            continue;
          }
          if (t.startsWith('-')) { i++; continue; }
          // First positional in sed without -e/-f is the SCRIPT — skip it.
          // We detect this by checking if it looks like a sed program
          // (starts with `s/`, `/pattern/`, address, etc.) — heuristic:
          // a positional that is a real file path will rarely START
          // with `/` followed by non-path metachar. Simpler: treat the
          // FIRST positional as script ONLY if no `-e` was given.
          // Robust approach: collect every remaining positional; if
          // it ends in a SOURCE_EXTENSIONS, treat as target. The
          // upstream isSourceFile() gate already filters non-source.
          if (!t.startsWith('-')) {
            pushTarget(out, {
              target: t,
              source: 'sed-i',
              segment,
              opaque: isOpaqueToken(t) || hasGlobMeta(t),
            });
          }
          i++;
        }
      }
    }

    // (e) CP / MV / INSTALL / RSYNC / LN
    if (['cp', 'mv', 'install', 'rsync', 'ln'].includes(headVerb)) {
      // Build positional list after dropping flags + arg-consuming flags.
      const argTakers = new Set([
        '-t', '--target-directory',
        '-S', '--suffix',
        '-e', '--rsh',
        '--chmod',
        '--files-from', '--include-from', '--exclude-from',
        '-m', '-o', '-g',
        '--backup',
      ]);
      const positionals = [];
      let i = 1; // skip verb
      let consumeNext = false;
      while (i < tokens.length) {
        const t = tokens[i];
        if (consumeNext) { consumeNext = false; i++; continue; }
        if (argTakers.has(t)) { consumeNext = true; i++; continue; }
        if (t.startsWith('--') && t.includes('=')) { i++; continue; }
        if (t.startsWith('-')) { i++; continue; }
        positionals.push(t);
        i++;
      }
      // For -t DIR / --target-directory=DIR — treat DIR as target.
      const targetDirIdx = tokens.findIndex((t) => t === '-t' || t === '--target-directory');
      if (targetDirIdx >= 0 && tokens[targetDirIdx + 1]) {
        const dir = tokens[targetDirIdx + 1];
        // Each preceding source's basename joined into DIR is a candidate.
        for (const p of positionals) {
          const candidate = `${dir.replace(/\/$/, '')}/${basename(p)}`;
          pushTarget(out, {
            target: candidate,
            source: 'cp-mv-dst',
            segment,
            opaque: isOpaqueToken(candidate) || hasGlobMeta(candidate),
          });
        }
      } else if (positionals.length >= 2) {
        // Last positional is DST.
        const dst = positionals[positionals.length - 1];
        pushTarget(out, {
          target: dst,
          source: 'cp-mv-dst',
          segment,
          opaque: isOpaqueToken(dst) || hasGlobMeta(dst),
        });
      } else if (headVerb === 'ln' && positionals.length === 1) {
        // ln -s SRC (one arg) → DST is implicit basename
        pushTarget(out, {
          target: positionals[0],
          source: 'cp-mv-dst',
          segment,
          opaque: isOpaqueToken(positionals[0]) || hasGlobMeta(positionals[0]),
        });
      }
    }

    // (f) INTERPRETER WRITE — node|deno|bun|python|ruby|perl|php|lua|tclsh|osascript
    if (INTERPRETER_VERBS.test(headVerb)) {
      // Look for -e/-c/--eval/-p with a script body. After normalizeShellCommand
      // quotes are gone, so the script body is whitespace-merged into the
      // surrounding tokens. We instead scan the WHOLE segment for write-API
      // call shapes + first string-literal arg.
      // Case-insensitive — the wrapper lowercases the command for
      // case-fold filesystem safety, which would otherwise turn
      // writeFileSync into writefilesync etc.
      const writeApiRe = /(writefilesync|appendfilesync|createwritestream|writefile|copyfilesync|renamesync|symlinksync|bun\.write|deno\.writefile)\s*\(\s*([^,\s)]+)/gi;
      for (const m of segment.matchAll(writeApiRe)) {
        const target = m[2].replace(/^[`'"]/, '').replace(/[`'"]$/, '');
        if (!target || DEV_NULL_SINKS.has(target)) continue;
        pushTarget(out, {
          target,
          source: 'interpreter-write',
          segment,
          opaque: isOpaqueToken(target) || hasGlobMeta(target),
        });
      }
      // open(path, 'w'|'a'|'x') style
      const openWriteRe = /open\s*\(\s*([^,\s)]+)\s*,\s*[`'"]?[wax]/gi;
      for (const m of segment.matchAll(openWriteRe)) {
        const target = m[1].replace(/^[`'"]/, '').replace(/[`'"]$/, '');
        if (!target || DEV_NULL_SINKS.has(target)) continue;
        pushTarget(out, {
          target,
          source: 'interpreter-write',
          segment,
          opaque: isOpaqueToken(target) || hasGlobMeta(target),
        });
      }
      // pathlib Path(…).write_text|write_bytes
      const pathlibRe = /path\s*\(\s*([^)]+)\s*\)\s*\.\s*write_(?:text|bytes)/gi;
      for (const m of segment.matchAll(pathlibRe)) {
        const target = m[1].replace(/^[`'"]/, '').replace(/[`'"]$/, '').trim();
        if (!target || DEV_NULL_SINKS.has(target)) continue;
        pushTarget(out, {
          target,
          source: 'interpreter-write',
          segment,
          opaque: isOpaqueToken(target) || hasGlobMeta(target),
        });
      }
    }

    // (g) TOUCH — every positional after dropping `-r REF` and flags.
    if (headVerb === 'touch') {
      let i = 1;
      let consumeNext = false;
      while (i < tokens.length) {
        const t = tokens[i];
        if (consumeNext) { consumeNext = false; i++; continue; }
        if (t === '-r' || t === '--reference' || t === '-d' || t === '--date' || t === '-t') {
          consumeNext = true;
          i++;
          continue;
        }
        if (t.startsWith('-')) { i++; continue; }
        pushTarget(out, {
          target: t,
          source: 'touch',
          segment,
          opaque: isOpaqueToken(t) || hasGlobMeta(t),
        });
        i++;
      }
    }

    // (h) SPONGE
    if (headVerb === 'sponge' || tokens.includes('sponge')) {
      const idx = tokens.indexOf('sponge');
      for (let i = idx + 1; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.startsWith('-')) continue;
        pushTarget(out, {
          target: t,
          source: 'sponge',
          segment,
          opaque: isOpaqueToken(t) || hasGlobMeta(t),
        });
      }
    }

    // (i) FORMATTER WRITE — only when the verb's `write` flag is set.
    if (FORMATTER_VERBS.has(headVerb)) {
      const needsFlag = {
        prettier: ['--write', '-w'],
        eslint: ['--fix'],
        gofmt: ['-w'],
        rustfmt: [], // default writes
        ruff: ['--fix'],
        biome: ['--write'],
        dprint: ['fmt'],
        black: [],
        isort: [],
        'clang-format': ['-i'],
        autopep8: ['-i', '--in-place'],
        yapf: ['-i', '--in-place'],
        ktlint: ['-F'],
        scalafmt: [],
        stylua: [],
        taplo: ['format'],
      };
      const required = needsFlag[headVerb];
      const hasWriteFlag = !required || required.length === 0 ||
                          required.some((f) => tokens.includes(f));
      if (hasWriteFlag) {
        for (let i = 1; i < tokens.length; i++) {
          const t = tokens[i];
          if (t.startsWith('-')) continue;
          // skip subcommand tokens like prettier `--check` (already skipped as flag),
          // ruff `format`, taplo `format`, dprint `fmt`
          if (i === 1 && /^(format|fmt|check)$/.test(t)) continue;
          if (DEV_NULL_SINKS.has(t)) continue;
          pushTarget(out, {
            target: t,
            source: 'formatter',
            segment,
            opaque: isOpaqueToken(t) || hasGlobMeta(t),
          });
        }
      }
    }

    // (j) PATCH / git apply / git restore / git checkout FILE
    if (headVerb === 'patch') {
      for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.startsWith('-')) continue;
        pushTarget(out, {
          target: t,
          source: 'patch',
          segment,
          opaque: isOpaqueToken(t) || hasGlobMeta(t),
        });
      }
    }
    if (headVerb === 'git' && tokens.length >= 2) {
      const sub = tokens[1];
      if (sub === 'apply' || sub === 'restore' || sub === 'checkout') {
        let sawSep = false;
        for (let i = 2; i < tokens.length; i++) {
          const t = tokens[i];
          if (t === '--') { sawSep = true; continue; }
          if (!sawSep && t.startsWith('-')) continue;
          if (!sawSep && (sub === 'restore' || sub === 'checkout')) {
            // require -- separator for safety; without it, the token
            // might be a branch/ref name.
            continue;
          }
          pushTarget(out, {
            target: t,
            source: 'git-apply',
            segment,
            opaque: isOpaqueToken(t) || hasGlobMeta(t),
          });
        }
      }
    }

    // (k) ARCHIVE EXTRACT — tar -x / unzip / 7z x / cpio -i with target dir.
    const archiveExtract = (
      (headVerb === 'tar' && tokens.some((t) => /x/.test(t) && t.startsWith('-'))) ||
      headVerb === 'unzip' ||
      (headVerb === '7z' && tokens[1] === 'x') ||
      (headVerb === 'cpio' && tokens.some((t) => t === '-i'))
    );
    if (archiveExtract) {
      for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i];
        if (t === '-C' || t === '-d') {
          const dir = tokens[i + 1];
          if (dir) {
            pushTarget(out, {
              target: dir,
              source: 'archive-extract',
              segment,
              opaque: true, // we cannot enumerate archive members statically
            });
          }
          i++;
        } else if (/^-o(.+)/.test(t)) {
          const dir = t.slice(2);
          pushTarget(out, {
            target: dir,
            source: 'archive-extract',
            segment,
            opaque: true,
          });
        }
      }
    }
  }

  return out;
}

// =============================================================================
// Target gate — applies isAllowedPath / isSourceFile to extracted targets.
// =============================================================================

function realpathOrParent(targetAbs) {
  try { return realpathSync(targetAbs); }
  catch {
    try { return join(realpathSync(dirname(targetAbs)), basename(targetAbs)); }
    catch { return null; }
  }
}

function classifyTargets(targets, cwd, dogfood) {
  const concrete = [];
  const opaque = [];
  for (const t of targets) {
    const { target } = t;
    if (!target) continue;
    if (DEV_NULL_SINKS.has(target)) continue;

    // Allowlist BEFORE symlink resolve — the raw token can be inside
    // .mpl/ / .claude/ / docs/learnings/.
    if (isAllowedPath(target, { dogfood })) continue;

    let targetAbs;
    try { targetAbs = resolvePath(cwd, target); }
    catch { continue; }
    const symlinkResolved = realpathOrParent(targetAbs);

    if (isAllowedPath(targetAbs, { dogfood })) continue;
    if (symlinkResolved && isAllowedPath(symlinkResolved, { dogfood })) continue;

    const isOpaqueTarget = t.opaque === true;
    const sourceLike = isSourceFile(target) ||
                       (symlinkResolved && isSourceFile(symlinkResolved));

    if (!sourceLike) {
      // For opaque targets without an extension, we can't prove they
      // ARE source — only conservative warning. We still emit so the
      // caller can decide to surface.
      if (isOpaqueTarget) {
        opaque.push({ ...t, targetAbs, symlinkResolved });
      }
      continue;
    }

    if (isOpaqueTarget) {
      opaque.push({ ...t, targetAbs, symlinkResolved });
    } else {
      concrete.push({ ...t, targetAbs, symlinkResolved });
    }
  }
  return { concrete, opaque };
}

// =============================================================================
// Decision builders
// =============================================================================

function allow(reason = '') {
  return { decision: 'allow', reason, signals: {}, sideEffects: [] };
}

function block(reason, sideEffects = [], signals = {}) {
  return { decision: 'block', reason, signals, sideEffects };
}

function warn(reason, additionalContext, sideEffects = [], signals = {}) {
  return {
    decision: 'warn',
    reason,
    signals: { ...signals, additionalContext },
    sideEffects,
  };
}

// =============================================================================
// Sub-handlers
// =============================================================================

function handleTask(event) {
  const { toolInput, cwd, state } = event;
  const sub = String(toolInput.subagent_type || toolInput.subagentType || '');
  if (!DECOMPOSER_SUBAGENT_TYPES.has(sub)) return allow();

  const callerTranscriptPath = event.callerTranscriptPath;
  // NOTE: the wrapper applies the `recordFirstTranscript` side effect BEFORE
  // calling handle(), then re-reads state into event.state. So by the time
  // this handler runs, `state.first_transcript_seen` reflects the post-record
  // value (the first call sets it; subsequent reads see it). This matches
  // the original mpl-write-guard.mjs behavior.
  const firstSeen = typeof state?.first_transcript_seen === 'string'
    ? state.first_transcript_seen
    : null;

  if (firstSeen && callerTranscriptPath && firstSeen === callerTranscriptPath) {
    return {
      decision: 'allow',
      reason: '',
      signals: {},
      sideEffects: [{
        kind: 'recordDecomposerDispatch',
        payload: { cwd, parentTranscriptPath: callerTranscriptPath },
      }],
    };
  }
  return allow();
}

function handleWriteEdit(event) {
  const { toolName, toolInput, cwd, state, callerTranscriptPath } = event;

  // NotebookEdit carries notebook_path; Edit/Write carries file_path.
  const filePath = toolInput.file_path
    || toolInput.filePath
    || toolInput.notebook_path
    || toolInput.notebookPath
    || '';

  // ---- pre-active guards: decomposition.yaml + state.json -----
  const isMplDir = existsSync(join(cwd, '.mpl'));
  if (process.env.MPL_FORCE_PURGE !== '1' && filePath && isMplDir) {
    const normalizedPath = normalizeFilePath(filePath);

    if (DECOMPOSITION_FILE_REGEX.test(normalizedPath)) {
      if (!isDecomposerDispatchActive(state, callerTranscriptPath)) {
        const reason =
          `[MPL #236 A1] Refused direct ${toolName} of decomposition.yaml: ` +
          `only the mpl-decomposer subagent may emit this file. ` +
          `Dispatch via Agent(subagent_type='mpl-decomposer', prompt='...') ` +
          `and let it write.`;
        return block(reason, [{
          kind: 'recordBlockedHook',
          payload: {
            cwd,
            hookId: HOOK_ID,
            phaseId: state?.current_phase,
            artifact: filePath,
            code: 'decomposition_writer_violation',
            reason,
            resumeInstruction:
              `Dispatch Agent(subagent_type='mpl-decomposer') and let it produce decomposition.yaml; do not Edit/Write it directly.`,
            retryContext: { file_path: filePath, tool: toolName },
          },
        }]);
      }
      // Decomposer dispatch is active — lock child + allow.
      return {
        decision: 'allow',
        reason: '',
        signals: {},
        sideEffects: [
          { kind: 'lockDecomposerChild', payload: { cwd, callerTranscriptPath } },
          { kind: 'clearBlockedHook', payload: { cwd, hookId: HOOK_ID, artifact: filePath } },
        ],
      };
    }

    if (STATE_FILE_REGEX.test(normalizedPath)) {
      const reason =
        `[MPL #236 A1] Refused direct ${toolName} of .mpl/state.json: only ` +
        `mpl-write-guard's internal writeState may modify the orchestrator ` +
        `state file. Direct Write/Edit can be chained (deactivate MPL → ` +
        `forge decomposer_dispatch → write decomposition.yaml) to bypass ` +
        `the A1 writer-identity gate. Use mpl_state_write / writeState, OR ` +
        `set MPL_FORCE_PURGE=1 in the same shell for a one-shot manual edit.`;
      return block(reason, [{
        kind: 'recordBlockedHook',
        payload: {
          cwd,
          hookId: HOOK_ID,
          phaseId: state?.current_phase,
          artifact: filePath,
          code: 'state_json_direct_write',
          reason,
          resumeInstruction:
            `Route the change through writeState() / mpl_state_write. Set MPL_FORCE_PURGE=1 only for a one-shot manual reset.`,
          retryContext: { file_path: filePath, tool: toolName },
        },
      }]);
    }
  }

  // Post-active.
  if (!event.isMplActive) return allow();

  if (!filePath) return allow();

  const dogfood = isDogfoodMode(cwd);

  if (isAllowedPath(filePath, { dogfood })) return allow();

  // Source-file branch.
  if (isSourceFile(filePath)) {
    const action = resolveRuleAction(cwd, state, 'direct_source_edit');
    if (action === 'off') {
      return {
        decision: 'allow',
        reason: '',
        signals: {},
        sideEffects: [{
          kind: 'clearBlockedHook',
          payload: { cwd, hookId: HOOK_ID, artifact: filePath },
        }],
      };
    }
    const dogfoodTag = dogfood ? ' [dogfood mode: MPL/ also enforced]' : '';
    const message = `[MPL DELEGATION NOTICE] Direct ${toolName} on source file: ${filePath}${dogfoodTag}

Source files should be edited by mpl-phase-runner agents, not the orchestrator.
Delegate via: Agent(subagent_type="mpl-phase-runner", prompt="Edit ${filePath} to ...")`;

    if (action === 'block') {
      return block(message, [{
        kind: 'recordBlockedHook',
        payload: {
          cwd,
          hookId: HOOK_ID,
          phaseId: state?.current_phase,
          artifact: filePath,
          code: 'direct_source_edit',
          reason: message,
          resumeInstruction:
            'Delegate the source-file edit to an mpl-phase-runner agent (Agent(subagent_type=mpl-phase-runner, ...)), then retry.',
          retryContext: { file_path: filePath, tool: toolName },
        },
      }]);
    }
    return warn(message, message, [{
      kind: 'clearBlockedHook',
      payload: { cwd, hookId: HOOK_ID, artifact: filePath },
    }]);
  }

  // Phase-scope check.
  try {
    const currentPhase = state?.current_phase;
    if (currentPhase && filePath) {
      const scope = getPhaseScope(cwd, currentPhase);
      if (scope && scope.allowed.length > 0) {
        const inScope = scope.allowed.some((f) =>
          filePath.endsWith(f) || filePath.includes(f),
        );
        if (!inScope) {
          const action = resolveRuleAction(cwd, state, 'phase_scope_violation');
          if (action === 'off') {
            return {
              decision: 'allow',
              reason: '',
              signals: {},
              sideEffects: [{
                kind: 'clearBlockedHook',
                payload: { cwd, hookId: HOOK_ID, artifact: filePath },
              }],
            };
          }
          const message = `[MPL SCOPE WARNING] File "${filePath}" is outside phase "${currentPhase}" scope.
Declared scope files: ${scope.allowed.slice(0, 5).join(', ')}${scope.allowed.length > 5 ? ` (+${scope.allowed.length - 5} more)` : ''}

This may cause cross-phase side effects. Verify this modification belongs in the current phase.`;
          if (action === 'block') {
            return block(message, [{
              kind: 'recordBlockedHook',
              payload: {
                cwd,
                hookId: HOOK_ID,
                phaseId: currentPhase,
                artifact: filePath,
                code: 'phase_scope_violation',
                reason: message,
                resumeInstruction:
                  `Restrict this write to files inside phase "${currentPhase}" declared scope, or move the work into the appropriate phase, then retry.`,
                retryContext: {
                  file_path: filePath,
                  phase: currentPhase,
                  allowed_sample: scope.allowed.slice(0, 5),
                },
              },
            }]);
          }
          return warn(message, message, [{
            kind: 'clearBlockedHook',
            payload: { cwd, hookId: HOOK_ID, artifact: filePath },
          }]);
        }
      }
    }
  } catch {
    // fail-open
  }

  return {
    decision: 'allow',
    reason: '',
    signals: {},
    sideEffects: [{
      kind: 'clearBlockedHook',
      payload: { cwd, hookId: HOOK_ID, artifact: filePath },
    }],
  };
}

function handleBash(event) {
  const { toolInput, cwd, state } = event;
  const command = toolInput.command || '';

  // Pre-active Bash guards: decomposition.yaml + state.json Bash writes.
  const isMplDir = existsSync(join(cwd, '.mpl'));
  if (process.env.MPL_FORCE_PURGE !== '1' && command && isMplDir) {
    const normalizedEarly = normalizeShellCommand(command).toLowerCase();

    // ---- Decomp Bash gate ----
    const hasCdCmdSub = /\bcd\b[^;|&\n]*\$\(/.test(normalizedEarly) ||
                        /\bcd\b[^;|&\n]*`/.test(normalizedEarly);
    const hasCdBareDecompWrite = /\bcd\b[\s\S]*&&[\s\S]*(?:>{1,2}|\btee\b|\bdd\b[^;|&]*\bof=)\s*decomposition\.ya?ml\b/i.test(normalizedEarly);
    const cdConstructedDecomp = hasCdCmdSub && /(?:>{1,2}|\btee\b|\bdd\b[^;|&]*\bof=)\s*decomposition\.ya?ml\b/i.test(normalizedEarly);
    let decompMention = /\.mpl\/mpl\/decomposition\.ya?ml/i.test(normalizedEarly)
                        || hasCdBareDecompWrite || cdConstructedDecomp;
    let symlinkWritesToDecomp = false;
    if (!decompMention) {
      const targetRe = /(?:[\d&]?>{1,2}\s*|\btee\b(?:\s+-\S+)*\s+|\bdd\b[^|;&]*\bof=\s*)([^\s|;&]+)/g;
      for (const m of normalizedEarly.matchAll(targetRe)) {
        const target = m[1];
        const targetAbs = resolvePath(cwd, target);
        let candidate = null;
        try { candidate = realpathSync(targetAbs); }
        catch {
          try { candidate = join(realpathSync(dirname(targetAbs)), basename(targetAbs)); }
          catch { /* skip */ }
        }
        if (candidate && /\.mpl\/mpl\/decomposition\.ya?ml$/i.test(candidate)) {
          decompMention = true;
          symlinkWritesToDecomp = true;
          break;
        }
      }
    }
    if (decompMention) {
      const SAFE_READS = new Set([
        'cat', 'ls', 'head', 'tail', 'wc', 'file', 'stat', 'du', 'df',
        'grep', 'rg', 'ag', 'ack', 'jq', 'yq',
        'less', 'more', 'sort', 'uniq', 'tac', 'nl',
        'diff', 'comm', 'sdiff',
        'echo', 'printf', 'pwd', 'type', 'which',
      ]);
      const segments = normalizedEarly.split(/[|;&]+/).map((s) => s.trim()).filter(Boolean);
      const allSegmentsSafe = segments.every((seg) => {
        const segHead = (seg.match(/^(\w+)/) || ['', ''])[1].toLowerCase();
        return SAFE_READS.has(segHead);
      });
      const writesToDecomp = (
        /[\d&]?>{1,2}[^|;&\n]*\.mpl\/mpl\/decomposition\.ya?ml/.test(normalizedEarly) ||
        /\btee\b[^|;&]*\.mpl\/mpl\/decomposition\.ya?ml/.test(normalizedEarly) ||
        /\bdd\b[^|;&]*\bof=[^|;&]*\.mpl\/mpl\/decomposition\.ya?ml/.test(normalizedEarly)
      );
      if (!allSegmentsSafe || writesToDecomp || symlinkWritesToDecomp) {
        const reason =
          `[MPL #236 A1] Refused Bash write to .mpl/mpl/decomposition.yaml: ` +
          `only the mpl-decomposer subagent may emit this file. Bash writes ` +
          `(including those allowed by a deactivated MPL state) bypass the ` +
          `writer-identity gate. Use Agent(subagent_type='mpl-decomposer', ` +
          `prompt='...'), OR set MPL_FORCE_PURGE=1 for a one-shot manual edit.`;
        return block(reason, [{
          kind: 'recordBlockedHook',
          payload: {
            cwd,
            hookId: HOOK_ID,
            phaseId: state?.current_phase,
            artifact: '.mpl/mpl/decomposition.yaml',
            code: 'decomposition_bash_write',
            reason,
            resumeInstruction:
              `Dispatch Agent(subagent_type='mpl-decomposer'); do not write decomposition.yaml from Bash.`,
            retryContext: { command },
          },
        }]);
      }
    }

    // ---- state.json Bash gate (early) ----
    const SAFE_READS_EARLY = new Set([
      'cat', 'ls', 'head', 'tail', 'wc', 'file', 'stat', 'du', 'df',
      'grep', 'rg', 'ag', 'ack', 'jq', 'yq',
      'less', 'more', 'sort', 'uniq', 'tac', 'nl',
      'diff', 'comm', 'sdiff',
      'echo', 'printf', 'pwd', 'type', 'which',
    ]);
    const cdCmdSubState = /\bcd\b[^;|&\n]*\$\(/.test(normalizedEarly) ||
                          /\bcd\b[^;|&\n]*`/.test(normalizedEarly);
    const hasCdBareStateWrite = /\bcd\b[\s\S]*&&[\s\S]*(?:>{1,2}|\btee\b|\bdd\b[^;|&]*\bof=)\s*state\.json\b/i.test(normalizedEarly);
    const cdConstructedState = cdCmdSubState && /(?:>{1,2}|\btee\b|\bdd\b[^;|&]*\bof=)\s*state\.json\b/i.test(normalizedEarly);
    let stateMention = /\.mpl\/state\.json/.test(normalizedEarly)
                       || hasCdBareStateWrite || cdConstructedState;
    let symlinkWritesToState = false;
    if (!stateMention) {
      const stateTargetReEarly = /(?:[\d&]?>{1,2}\s*|\btee\b(?:\s+-\S+)*\s+|\bdd\b[^|;&]*\bof=\s*)([^\s|;&]+)/g;
      for (const m of normalizedEarly.matchAll(stateTargetReEarly)) {
        const targetAbs = resolvePath(cwd, m[1]);
        let candidate = null;
        try { candidate = realpathSync(targetAbs); }
        catch {
          try { candidate = join(realpathSync(dirname(targetAbs)), basename(targetAbs)); }
          catch { /* skip */ }
        }
        if (candidate && /\.mpl\/state\.json$/i.test(candidate)) {
          stateMention = true;
          symlinkWritesToState = true;
          break;
        }
      }
    }
    if (stateMention) {
      const segmentsEarly = normalizedEarly.split(/[|;&]+/).map((s) => s.trim()).filter(Boolean);
      const allSafeEarly = segmentsEarly.length > 0 && segmentsEarly.every((seg) => {
        const h = (seg.match(/^(\w+)/) || ['', ''])[1].toLowerCase();
        return SAFE_READS_EARLY.has(h);
      });
      const writesEarly = (
        /[\d&]?>{1,2}[^|;&\n]*\.mpl\/state\.json/.test(normalizedEarly) ||
        /\btee\b[^|;&]*\.mpl\/state\.json/.test(normalizedEarly) ||
        /\bdd\b[^|;&]*\bof=[^|;&]*\.mpl\/state\.json/.test(normalizedEarly)
      );
      if (!allSafeEarly || writesEarly || symlinkWritesToState) {
        const reason =
          `[MPL #236 A1] Refused Bash write to .mpl/state.json: only ` +
          `mpl-write-guard's internal writeState may modify the orchestrator ` +
          `state file. Bash writes (including those allowed by a deactivated ` +
          `MPL state) bypass the writer-identity gate and would let any caller ` +
          `forge decomposer_dispatch / first_transcript_seen / other capability ` +
          `fields. Set MPL_FORCE_PURGE=1 for a one-shot manual reset.`;
        return block(reason, [{
          kind: 'recordBlockedHook',
          payload: {
            cwd,
            hookId: HOOK_ID,
            phaseId: state?.current_phase,
            artifact: '.mpl/state.json',
            code: 'state_json_bash_write',
            reason,
            resumeInstruction:
              `Route the change through writeState(); set MPL_FORCE_PURGE=1 only for a one-shot manual reset.`,
            retryContext: { command },
          },
        }]);
      }
    }
  }

  if (!event.isMplActive) return allow();

  // ---- Post-active Bash inspection ----
  const normalizedCommand = normalizeShellCommand(command).toLowerCase();

  // state.json mention guard (post-active duplicate, mirrors original).
  const SAFE_READ_HEADS = new Set([
    'cat', 'ls', 'head', 'tail', 'wc', 'file', 'stat', 'du', 'df',
    'grep', 'rg', 'ag', 'ack',
    'jq', 'yq',
    'less', 'more',
    'sort', 'uniq', 'tac', 'nl',
    'diff', 'comm', 'sdiff',
    'echo', 'printf', 'pwd', 'type', 'which',
  ]);
  const stateJsonMention = /\.mpl\/state\.json/.test(normalizedCommand);
  const segmentsStateGuard = normalizedCommand
    .split(/[|;&]+/).map((s) => s.trim()).filter(Boolean);
  const isSafeRead = segmentsStateGuard.length > 0 && segmentsStateGuard.every((seg) => {
    const segHead = (seg.match(/^(\w+)/) || ['', ''])[1].toLowerCase();
    return SAFE_READ_HEADS.has(segHead);
  });
  let writesToStateJson = (
    /[\d&]?>{1,2}[^|;&\n]*\.mpl\/state\.json/.test(normalizedCommand) ||
    /\btee\b[^|;&]*\.mpl\/state\.json/.test(normalizedCommand) ||
    /\bdd\b[^|;&]*\bof=[^|;&]*\.mpl\/state\.json/.test(normalizedCommand)
  );
  let symlinkWritesToStateJson = false;
  if (!stateJsonMention) {
    const stateTargetRe = /(?:[\d&]?>{1,2}\s*|\btee\b(?:\s+-\S+)*\s+|\bdd\b[^|;&]*\bof=\s*)([^\s|;&]+)/g;
    for (const m of normalizedCommand.matchAll(stateTargetRe)) {
      const target = m[1];
      const targetAbs = resolvePath(cwd, target);
      let candidate = null;
      try { candidate = realpathSync(targetAbs); }
      catch {
        try { candidate = join(realpathSync(dirname(targetAbs)), basename(targetAbs)); }
        catch { /* skip */ }
      }
      if (candidate && /\.mpl\/state\.json$/i.test(candidate)) {
        symlinkWritesToStateJson = true;
        writesToStateJson = true;
        break;
      }
    }
  }
  if ((stateJsonMention || symlinkWritesToStateJson) && (!isSafeRead || writesToStateJson) && process.env.MPL_FORCE_PURGE !== '1') {
    const reason =
      `[MPL #236 A1] Refused Bash write to .mpl/state.json: only ` +
      `mpl-write-guard's internal writeState may modify the orchestrator ` +
      `state file. Allowing this would let any caller forge ` +
      `decomposer_dispatch / first_transcript_seen / other capability ` +
      `fields. If you really need to edit state manually, set ` +
      `MPL_FORCE_PURGE=1 in the same shell.`;
    return block(reason, [{
      kind: 'recordBlockedHook',
      payload: {
        cwd,
        hookId: HOOK_ID,
        phaseId: state?.current_phase,
        artifact: '.mpl/state.json',
        code: 'state_json_bash_write',
        reason,
        resumeInstruction:
          `Use the orchestrator's state-write tool path (or the Read+Edit tool if appropriate); set MPL_FORCE_PURGE=1 only if a manual reset is intended.`,
        retryContext: { command },
      },
    }]);
  }

  // Protected-path delete check.
  const protectedTarget = matchesProtectedDelete(command, cwd);
  if (protectedTarget && process.env.MPL_FORCE_PURGE !== '1') {
    const reason =
      `[MPL #236 A3] Refused destructive write to protected path "${protectedTarget}". ` +
      `Command: \`${command}\`. The mpl-cancel skill (skills/mpl-cancel/SKILL.md) forbids ` +
      `deleting any of: ${PROTECTED_DELETE_TARGETS.join(', ')} (decomposition / contracts / ` +
      `cross-session memory / learnings). If you are running a real reset, set MPL_FORCE_PURGE=1 ` +
      `in the same shell, OR invoke /mpl:mpl-cancel which performs an auditable cleanup.`;
    return block(reason, [{
      kind: 'recordBlockedHook',
      payload: {
        cwd,
        hookId: HOOK_ID,
        phaseId: state?.current_phase,
        artifact: protectedTarget,
        code: 'protected_path_delete',
        reason,
        resumeInstruction:
          `Either run /mpl:mpl-cancel (auditable cleanup that preserves intended state) or set MPL_FORCE_PURGE=1 in the same shell if you really want this rm to proceed, then retry.`,
        retryContext: { command, target: protectedTarget },
      },
    }]);
  }

  // ===========================================================================
  // Move #6: Bash write-target enforcement
  // ===========================================================================
  const gateAction = resolveRuleAction(cwd, state, 'bash_write_targets');
  if (gateAction !== 'off') {
    const dogfood = isDogfoodMode(cwd);
    const extracted = extractBashWriteTargets(normalizedCommand);
    if (extracted.length > 0) {
      const { concrete, opaque } = classifyTargets(extracted, cwd, dogfood);

      if (concrete.length > 0) {
        const sourceTags = Array.from(new Set(concrete.map((c) => c.source))).join(',');
        const sampleTargets = concrete.slice(0, 3).map((c) => c.target);
        const action = resolveRuleAction(cwd, state, 'direct_source_edit');
        if (action === 'off') {
          // Honor per-rule off.
          return {
            decision: 'allow',
            reason: '',
            signals: {},
            sideEffects: concrete.map((c) => ({
              kind: 'clearBlockedHook',
              payload: { cwd, hookId: HOOK_ID, artifact: c.target },
            })),
          };
        }
        const dogfoodTag = dogfood ? ' [dogfood mode: MPL/ also enforced]' : '';
        const message =
          `[MPL DELEGATION NOTICE] Bash command writes to source file(s) ` +
          `via ${sourceTags}: ${sampleTargets.join(', ')}` +
          (concrete.length > 3 ? ` (+${concrete.length - 3} more)` : '') +
          `${dogfoodTag}\n\nSource files should be edited by mpl-phase-runner agents, ` +
          `not the orchestrator. Delegate via: Agent(subagent_type="mpl-phase-runner", ` +
          `prompt="Edit ${sampleTargets[0]} to ...")`;

        if (action === 'block') {
          return block(message, [{
            kind: 'recordBlockedHook',
            payload: {
              cwd,
              hookId: HOOK_ID,
              phaseId: state?.current_phase,
              artifact: sampleTargets[0],
              code: 'direct_source_edit',
              reason: message,
              resumeInstruction:
                'Delegate the source-file edit to an mpl-phase-runner agent (Agent(subagent_type=mpl-phase-runner, ...)), then retry.',
              retryContext: {
                command,
                targets: sampleTargets,
                sources: sourceTags,
                tool: 'Bash',
              },
            },
          }]);
        }
        // warn
        return warn(message, message, []);
      }

      // Opaque-only matches → ALWAYS warn (cannot prove block).
      if (opaque.length > 0) {
        const sourceTags = Array.from(new Set(opaque.map((o) => o.source))).join(',');
        const sampleTargets = opaque.slice(0, 3).map((o) => o.target);
        const message =
          `[MPL OPAQUE-WRITE NOTICE] Bash command writes via ${sourceTags} to ` +
          `target(s) the policy cannot statically resolve: ${sampleTargets.join(', ')}. ` +
          `If these resolve to source files, route the edit through ` +
          `Agent(subagent_type="mpl-phase-runner", ...).`;
        return warn(message, message, []);
      }
    }
  }

  // Dangerous-bash warn.
  if (isDangerousBashCommand(command)) {
    const message = `[MPL SAFETY WARNING] Potentially dangerous command detected:
  ${command}

This command may cause irreversible changes. If this is intentional (e.g., cleanup),
ensure you have the correct target path. The command will proceed, but please verify.`;
    return warn(message, message, []);
  }

  return allow();
}

// =============================================================================
// Public entrypoint
// =============================================================================

/**
 * Top-level source-edit policy entrypoint.
 *
 * @param {{
 *   event: 'PreToolUse',
 *   toolName: string,
 *   toolInput: object,
 *   cwd: string,
 *   state: object,
 *   config: object,
 *   data: object,
 *   isMplActive: boolean,
 *   callerTranscriptPath: string | null,
 * }} event
 * @returns {Promise<{
 *   decision: 'block' | 'allow' | 'warn',
 *   reason: string,
 *   signals: object,
 *   sideEffects: Array<{kind: string, payload: object}>,
 * }>}
 */
export async function handle(event) {
  const toolName = event.toolName || '';
  const isWriteTool = [
    'Edit', 'Write', 'MultiEdit', 'NotebookEdit',
    'edit', 'write', 'multiEdit', 'multiedit', 'notebookEdit', 'notebookedit',
  ].includes(toolName);
  const isBashTool = ['Bash', 'bash'].includes(toolName);
  const isTaskTool = ['Task', 'Agent', 'task', 'agent'].includes(toolName);

  if (!isWriteTool && !isBashTool && !isTaskTool) {
    return allow();
  }

  // NOTE: the wrapper applies `recordFirstTranscript` BEFORE calling handle()
  // and passes the post-record state in `event.state`. This mirrors the
  // original mpl-write-guard.mjs ordering where recordFirstTranscript ran
  // first, then the Task / decomp gates read state.

  let result;
  if (isTaskTool) {
    result = handleTask(event);
  } else if (isBashTool) {
    result = handleBash(event);
  } else {
    result = handleWriteEdit(event);
  }

  return result;
}

// Re-export legacy named exports so downstream tests
// (mpl-write-guard.test.mjs, mpl-issue-235, mpl-issue-236) keep importing
// these symbols from this module path without code change.
export { readState };
