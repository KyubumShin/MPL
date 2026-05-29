#!/usr/bin/env node
/**
 * MPL Write Guard Hook (PreToolUse)
 *
 * Two responsibilities:
 * 1. Blocks orchestrator from directly editing source files when MPL is active.
 *    Source file edits must be delegated to mpl-phase-runner agents.
 * 2. Warns on dangerous Bash commands (rm -rf, DROP TABLE, git push --force, etc.)
 *    that could cause irreversible damage. (T-01)
 * 3. Phase-scoped file lock — warns on writes outside current phase's scope. (T-01 P2)
 *
 * When MPL is inactive: does nothing (no interference with normal workflow)
 * When MPL is active: guards Edit/Write on source files + warns on dangerous Bash
 */

import { dirname, join, extname, resolve as resolvePath } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import shared MPL state utility
const { isMplActive, readState } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);

// Import shared stdin reader
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);

// Import decomposition parser for phase-scoped file lock (T-01 Phase 2, v3.9)
const { getPhaseScope } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-decomposition-parser.mjs')).href
);

// P0-2 / #110 — per-rule policy resolver. P0-3 (#111) consumes
// `direct_source_edit` and `phase_scope_violation`.
const { resolveRuleAction } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-enforcement.mjs')).href
);
const { loadConfig } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-config.mjs')).href
);
// #235: record envelope on `decision: block` so mpl-recover can
// dispatch and BLOCKED_HOOK_STALE doesn't fire.
const { recordBlockedHook, clearBlockedHook } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-blocked-hook.mjs')).href
);
// #236: state-based subagent dispatch tracking so the decomposition.yaml
// writer-identity check can verify it's the decomposer subagent.
// (readState already imported above with isMplActive.)
const { writeState } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);

const HOOK_ID = 'mpl-write-guard';

// #236 A1: orchestrator MUST NOT directly Write/Edit
// `.mpl/mpl/decomposition.yaml`. Only the mpl-decomposer agent may
// (commands/mpl-run-decompose.md:16). We detect the writer identity
// via a state-based dispatch flag set when the orchestrator dispatches
// Agent(subagent_type='mpl-decomposer') and cleared on Stop.
const DECOMPOSITION_FILE_REGEX = /(^|\/)\.mpl\/mpl\/decomposition\.ya?ml$/;

// Claude r9 on PR #249 [security]: the orchestrator can Write
// `.mpl/state.json` (it sits inside the `/\.mpl\//` allowlist), and
// the writer-identity check at A1 trusted whatever
// `state.decomposer_dispatch.parent_transcript_path` value it found
// — so the orchestrator could plant a `parent_transcript_path !=
// its own transcript`, then write decomposition.yaml. Reject any
// Write/Edit to .mpl/state.json whose payload introduces or mutates
// `decomposer_dispatch.*` — only the hook itself may set those keys.
const STATE_FILE_REGEX = /(^|\/)\.mpl\/state\.json$/;
const DECOMPOSER_DISPATCH_FIELD_REGEX = /"decomposer_dispatch"\s*:/;
const DECOMPOSER_SUBAGENT_TYPES = new Set([
  'mpl-decomposer',
  'mpl:mpl-decomposer',
]);
// Dispatch flag lifetime in ms — a real decompose run typically
// completes in a few minutes; 30 min is a conservative ceiling.
const DECOMPOSER_DISPATCH_TTL_MS = 30 * 60 * 1000;

// #236 A3: skill mpl-cancel declares these paths NEVER deletable.
// The dangerous-bash check used to allowlist `rm -rf .mpl` as "safe
// cleanup" — that allowed the exact destructive op the SKILL forbids.
// Fix: every rm against any of these (or any descendant) is hard-blocked
// regardless of the safe-cleanup allowlist. Override via env var
// MPL_FORCE_PURGE=1 — operators initiating a real reset can set this
// in the same shell.
const PROTECTED_DELETE_TARGETS = [
  '.mpl/mpl',
  '.mpl/contracts',
  '.mpl/memory',
  'docs/learnings',
];

// Dogfood mode (P0-3, #111): when developing the MPL plugin against itself,
// `/MPL/` paths must be treated like ordinary source — orchestrator should
// route those edits through phase-runner the same as application code.
// Toggle via .mpl/config.json `dogfood: true` or env `MPL_DOGFOOD=1`.
const DOGFOOD_SUPPRESSED = /\/MPL\//;

// Allowed path patterns (orchestrator CAN write to these). DOGFOOD_SUPPRESSED
// is included by reference so isAllowedPath() can drop it when dogfood is on.
const ALLOWED_PATTERNS = [
  /\.mpl\//,           // .mpl/ state directory
  /\.omc\//,           // .omc/ OMC state
  /\.claude\//,        // .claude/ config
  /\/\.claude\//,      // absolute .claude/ paths
  DOGFOOD_SUPPRESSED,  // /MPL/ plugin directory (suppressed in dogfood mode)
  /PLAN\.md$/,         // PLAN.md (orchestrator manages checkboxes)
  /docs\/learnings\//, // learnings directory
];

function isDogfoodMode(cwd) {
  if (process.env.MPL_DOGFOOD === '1') return true;
  try {
    const cfg = loadConfig(cwd);
    return cfg?.dogfood === true;
  } catch {
    return false;
  }
}

// Source file extensions (orchestrator must NOT write to these)
const SOURCE_EXTENSIONS = new Set([
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
]);

// Dangerous Bash command patterns (T-01, v3.8)
const DANGEROUS_BASH_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force)/,   // rm -rf, rm -f, rm --force
  /\bgit\s+push\s+.*--force/,                        // git push --force
  /\bgit\s+reset\s+--hard/,                          // git reset --hard
  /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i,              // DROP TABLE/DATABASE/SCHEMA
  /\bTRUNCATE\s+TABLE\b/i,                            // TRUNCATE TABLE
  /\bkubectl\s+delete\b/,                             // kubectl delete
  /\bdocker\s+rm\s+(-[a-zA-Z]*f|--force)/,           // docker rm -f
  /\bdocker\s+system\s+prune/,                        // docker system prune
  /\bchmod\s+777\b/,                                  // chmod 777
];

// Safe cleanup patterns that look dangerous but are common/expected.
// #236 A3 removed `.mpl` from this set — it conflicted with the
// mpl-cancel SKILL contract that explicitly forbids deleting any of
// `.mpl/mpl/**`, `.mpl/contracts/*.json`, `.mpl/memory/`, and
// `docs/learnings/`. The protected-delete check (matchesProtectedDelete)
// runs BEFORE the dangerous-bash check now and hard-blocks regardless
// of this allowlist.
const SAFE_CLEANUP_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force\s+)(\.\/)?node_modules/,
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force\s+)(\.\/)?\.next/,
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force\s+)(\.\/)?dist/,
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force\s+)(\.\/)?build/,
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force\s+)(\.\/)?\.cache/,
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force\s+)(\.\/)?coverage/,
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force\s+)(\.\/)?__pycache__/,
];

function isDangerousBashCommand(command) {
  if (!command) return false;
  // Check safe cleanup first (allowlist takes priority)
  if (SAFE_CLEANUP_PATTERNS.some(p => p.test(command))) return false;
  return DANGEROUS_BASH_PATTERNS.some(p => p.test(command));
}

// #236 A3: does `command` attempt to remove any PROTECTED_DELETE_TARGETS
// path (or one of its descendants)? Returns the matched target on hit,
// null otherwise. Matches the canonical `rm` family and the wrapped
// `find ... -delete` form, and resolves each path token against the
// workspace `cwd` so workspace-absolute paths (`/abs/.../MPL/.mpl/mpl`)
// and `..`/`.` traversal forms still match.
//
// Codex r1 retry on PR #249: the original token-prefix regex missed
// `rm -rf /Users/.../MPL/.mpl/mpl` because the protected substring
// appeared mid-path (no whitespace/quote boundary just before it).
// Resolving each token via path.resolve(cwd, token) normalizes those
// forms to a single canonical absolute path that we can compare
// against the resolved protected roots.
// Codex r7 on PR #249 [data-integrity]: substitute simple variable
// assignments. `p=.mpl; rm -rf ${p}/mpl` reaches the shell as
// `rm -rf .mpl/mpl`. Collect every leading `name=value` from each
// statement (`;`/`&&`/`||`/newline split), then replace `$name` and
// `${name}` references throughout the command. Supports `export name=…`
// prefix and quoted values; values stop at the first whitespace
// (`name="multi word"` is uncommon in protected-path bypass shapes).
function expandSimpleVars(text) {
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

// Expand bash brace patterns within each whitespace-separated token,
// repeating until no more `{…}` groups remain (10-round backstop for
// pathological nesting). Cartesian: `{a,b}{c,d}` → `ac ad bc bd`.
function expandShellBraces(text) {
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

function matchesProtectedDelete(command, cwd) {
  if (!command || typeof command !== 'string') return null;
  // Strip leading wrapper before checking the head — `sudo rm -rf …`
  // must still trip.
  let normalized = command.replace(/^\s*(sudo|time|nice|env)\s+/, '').trim();
  // Identify destructive operations against the protected paths. Each
  // of these is a way to remove or wipe a path that the mpl-cancel
  // SKILL forbids — `rm` is the obvious one, but `mv` away,
  // redirect-truncate (`> file`), `shred`, `unlink`, `truncate`, and
  // `cp /dev/null …` are equally destructive.
  //
  // Claude r7 on PR #249 [data-integrity]: pre-r7 the entry gate was
  // only `rm`/`find -delete`, so the non-rm forms above silently
  // passed.
  const isDestructive = (
    /\brm\b/.test(normalized) ||
    /\bfind\b.*-delete\b/.test(normalized) ||
    /\bmv\b/.test(normalized) ||
    /\bshred\b/.test(normalized) ||
    /\bunlink\b/.test(normalized) ||
    /\btruncate\b/.test(normalized) ||
    /\bcp\b.*\/dev\/null/.test(normalized) ||
    // Codex r9 on PR #249 [data-integrity]: writer utilities that
    // create/overwrite their path operand are destructive too.
    // `tee FILE` opens FILE for write and overwrites it.
    /\btee\b/.test(normalized) ||
    /\bdd\b.*\bof=/.test(normalized) ||
    // Codex r11 on PR #249 [data-integrity]: `tar --remove-files` and
    // `rsync --remove-source-files` are destructive — both delete
    // their source operand after the copy completes.
    /\btar\b.*--remove-files\b/.test(normalized) ||
    /\brsync\b.*--remove-source-files\b/.test(normalized) ||
    // Codex r10 on PR #249 [data-integrity]: interpreter one-liners
    // (`node -e "require('fs').rmSync('.mpl/mpl')"`, `python -c
    // "shutil.rmtree('.mpl/mpl')"`) can destroy protected paths
    // without invoking any shell-level destructive verb. Treat any
    // common interpreter as a possible-destructive entry; the
    // substring/token checks then catch the protected target literal
    // inside the eval body. Pure read-only interpreter use (`node
    // script.js` without mentioning a protected path) is not blocked
    // because neither the substring nor the token check would match.
    /\b(node|deno|bun|python\d?|ruby|perl|php|lua|tclsh|osascript|awk|sed)\b/.test(normalized) ||
    // Codex r8 on PR #249 [data-integrity]: POSIX shell redirection
    // does not require whitespace after `>`/`>>`/`&>`. `echo x
    // >.mpl/mpl/foo` truncates the protected file. Allow optional
    // fd-prefix (`2>`, `1>>`) and tolerate adjacent operand.
    /(?:^|[\s;|&])\d?>{1,2}/.test(normalized) ||
    /(?:^|[\s;|&])&>{1,2}/.test(normalized)
  );
  if (!isDestructive) return null;

  // Pre-normalize the command to the form a real shell would execute,
  // so substring + token checks see the same path the OS sees.
  // Layered from "most decoded" to "least decoded":
  //   - Codex r5 on PR #249 [data-integrity]: Bash ANSI-C quoting
  //     ($'…') decodes hex (\xHH), octal (\OOO), and Unicode (\uHHHH /
  //     \UHHHHHHHH) escapes. `rm -rf $'.mpl\x2fmpl'` deletes `.mpl/mpl`.
  //     Decode these escapes to characters BEFORE the generic
  //     backslash strip so they don't get clobbered to `x2f`.
  //   - Codex r4 on PR #249 [data-integrity]: POSIX shells remove
  //     generic backslash escapes — `rm -rf .mpl\/mpl` deletes
  //     `.mpl/mpl`. After ANSI-C decoding, strip every remaining
  //     `\X` → `X`.
  //   - Codex r3 on PR #249 [data-integrity]: shells concatenate
  //     adjacent quote fragments — `.mpl/""mpl` and `.mpl"/"mpl`
  //     resolve to `.mpl/mpl`. Strip every `"`, `'`, backtick.
  //   - Codex r2 on PR #249 [logic]: shells normalize runs of `/`
  //     after expansion (`$PWD/.mpl//mpl` deletes `.mpl/mpl`).
  //     Collapse repeated slashes to one.
  // All transforms preserve token-boundary whitespace.
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
    .replace(/\/+/g, '/');

  // Claude r5 on PR #249 [data-integrity]: Bash brace expansion
  // (`.mpl/{mpl,contracts}` → `.mpl/mpl .mpl/contracts`, cartesian
  // `{a,b}{c,d}` → `ac ad bc bd`) was a new class outside the
  // previously-closed list. Expand braces here so the literal target
  // appears in one of the expanded tokens and the substring + token
  // checks fire normally. Iterative leftmost-brace expansion handles
  // nested + cartesian forms; we cap at 10 iterations as a backstop.
  normalized = expandShellBraces(normalized);
  normalized = expandSimpleVars(normalized);

  // Claude r1 on PR #249 [logic] (concrete repros): shell-expansion
  // forms (`$PWD`, `$(pwd)`), parenthesized subshells, variable
  // operands all defeat literal token resolution. Defense-in-depth:
  // ALSO match the protected substring anywhere in the command.
  // Over-blocks on incidental mentions — `MPL_FORCE_PURGE=1` is the
  // operator escape hatch already documented in the block reason.
  for (const target of PROTECTED_DELETE_TARGETS) {
    if (normalized.includes(target)) return target;
  }

  const resolvedRoots = PROTECTED_DELETE_TARGETS.map((target) => ({
    target,
    abs: resolvePath(cwd, target),
  }));

  // Tokenize on whitespace AND `;`/`&&`/`||`/`|`/`(`/`)` so a
  // multi-command line + subshell surfaces every operand.
  const tokens = normalized
    // Codex r8: also split on `>` / `<` so redirect operators with
    // no whitespace before the operand (`echo x >.mpl/mpl/foo`) split
    // off the path token cleanly.
    .split(/[\s;|&()<>]+/)
    .map((t) => t.replace(/^[\\$]+/, '').replace(/[\\)]+$/, ''))
    .filter(Boolean);

  for (const token of tokens) {
    // Skip flag tokens; they can't be paths.
    if (token.startsWith('-')) continue;
    // Skip known program names so we don't false-match `rm` itself.
    if (/^(rm|find|sudo|time|nice|env|cd|pushd|popd|mkdir|mv|shred|unlink|truncate|cp|export|tee|dd|tar|rsync|echo|cat|printf)$/i.test(token)) continue;

    // Codex r6 on PR #249 [data-integrity]: shell pathname expansion
    // (glob metachars `*`, `?`, `[…]`) lets a command operand expand
    // at execution time to a protected path without the literal
    // appearing in the hook input. E.g. `rm -rf .mpl/m*` expands to
    // `rm -rf .mpl/mpl` (and `.mpl/memory`). When a token contains
    // glob meta, the literal prefix (before the first metachar) is
    // resolved; if the glob COULD reasonably expand into a path that
    // equals OR shares a path with a protected root, block. Same
    // ancestor-match logic as below.
    const globIdx = token.search(/[*?[]/);
    if (globIdx >= 0) {
      const literalPrefix = token.slice(0, globIdx);
      let absPrefix;
      try { absPrefix = resolvePath(cwd, literalPrefix); }
      catch { continue; }
      for (const { target, abs: rootAbs } of resolvedRoots) {
        // For glob tokens, any protected root whose abs path STARTS
        // WITH the literal prefix is a possible expansion — the glob
        // metachar (`*`/`?`/`[…]`) could fill the rest. `.mpl/m*` →
        // absPrefix `.mpl/m`; `.mpl/mpl` starts with `.mpl/m` → block.
        // Also include the inverse: `.mpl/sub/*` whose absPrefix is
        // already deeper than `.mpl/mpl` could expand to a descendant.
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
      // Claude r2 on PR #249 [security]: also match ANCESTORS of
      // protected roots. `rm -rf .mpl` destroys `.mpl/mpl`,
      // `.mpl/contracts`, `.mpl/memory`. `find . -delete` destroys
      // every file under cwd including protected ones. The pre-fix
      // check only caught descendants of a root, not roots-of-the-root.
      if (
        abs === rootAbs ||
        abs.startsWith(rootAbs + '/') ||
        rootAbs.startsWith(abs + '/')
      ) return target;
    }
  }
  return null;
}

// #236 A1: record state.decomposer_dispatch when the orchestrator
// dispatches Agent(subagent_type='mpl-decomposer'). Used by the
// decomposition.yaml writer-identity check below.
//
// Codex r1 retry on PR #249: an ambient time-only flag let the
// orchestrator itself write decomposition.yaml within the TTL
// window. The fix is to also pin the PARENT (orchestrator) transcript
// path at dispatch time, then on a later write require the calling
// transcript to be DIFFERENT from the dispatcher's — a subagent's
// transcript is always a distinct file.
function recordDecomposerDispatch(cwd, parentTranscriptPath) {
  try {
    writeState(cwd, {
      decomposer_dispatch: {
        dispatched_at: new Date().toISOString(),
        parent_transcript_path: parentTranscriptPath || null,
        // Claude r3 on PR #249 [contract-break]: re-dispatch must
        // reset the lock — without an explicit null, writeState's
        // deepMerge preserves the previous child_transcript_path,
        // so the new decomposer's write (with a fresh transcript)
        // is wrongly rejected even though it IS the legitimate
        // freshly-dispatched subagent.
        child_transcript_path: null,
      },
    });
  } catch { /* best-effort */ }
}

// #236 A1: is the current write coming from the decomposer subagent?
//   - dispatch flag must be set,
//   - within the TTL,
//   - the calling transcript_path must DIFFER from the recorded
//     parent (orchestrator) transcript_path,
//   - AND lock-on-first-write: the first non-parent transcript that
//     writes decomposition.yaml under this dispatch is recorded as
//     `child_transcript_path`. Subsequent writes MUST come from the
//     same child transcript — any OTHER subagent (phase-runner, etc.)
//     calling Write during the window would carry a third transcript
//     and be rejected.
//
// When parent_transcript_path was not recorded (legacy state), we
// fail closed — the writer-identity check cannot be satisfied without
// a parent reference, so the write is rejected.
//
// Codex r2 on PR #249 [logic]: without lock-on-first-write, ANY
// subagent active in the window could write decomposition.yaml — the
// dispatch flag was a capability for "any non-orchestrator", not for
// the specific decomposer. The lock binds the capability to the
// FIRST consuming child.
function isDecomposerDispatchActive(state, callerTranscriptPath) {
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
  // Lock-on-first-write: if a child transcript has already been
  // recorded for this dispatch, only that exact transcript may proceed.
  const lockedChild = typeof flag.child_transcript_path === 'string'
    ? flag.child_transcript_path
    : null;
  if (lockedChild) return callerTranscriptPath === lockedChild;
  // First consumer — caller is whoever is acting as the decomposer
  // subagent. The actual locking write happens in main().
  return true;
}

// #236 A1: record the locked child transcript on the FIRST allowed
// Write/Edit of decomposition.yaml during the dispatch window.
function lockDecomposerChild(cwd, callerTranscriptPath) {
  try {
    const state = readState(cwd) || {};
    const flag = state.decomposer_dispatch;
    if (!flag || typeof flag !== 'object') return;
    if (typeof flag.child_transcript_path === 'string') return;
    writeState(cwd, {
      decomposer_dispatch: {
        ...flag,
        child_transcript_path: callerTranscriptPath,
      },
    });
  } catch { /* best-effort */ }
}

function isAllowedPath(filePath, opts = {}) {
  if (!filePath) return true;
  const { dogfood = false } = opts;
  return ALLOWED_PATTERNS.some((pattern) => {
    if (dogfood && pattern === DOGFOOD_SUPPRESSED) return false;
    return pattern.test(filePath);
  });
}

function isSourceFile(filePath) {
  if (!filePath) return false;
  return SOURCE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

async function main() {
  const input = await readStdin();

  let data;
  try {
    data = JSON.parse(input);
  } catch {
    // Parse error: allow and suppress
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const toolName = data.tool_name || data.toolName || '';

  // Tool sets we care about. Task/Agent only used for the decomposer
  // dispatch flag (A1); Bash for the safety + protected-delete check
  // (A3); Edit/Write/MultiEdit for the source-file / phase-scope /
  // decomposition-writer checks.
  const isWriteTool = ['Edit', 'Write', 'MultiEdit', 'edit', 'write', 'multiEdit', 'multiedit'].includes(toolName);
  const isBashTool = ['Bash', 'bash'].includes(toolName);
  const isTaskTool = ['Task', 'Agent', 'task', 'agent'].includes(toolName);
  if (!isWriteTool && !isBashTool && !isTaskTool) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Check if MPL is active
  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) {
    // MPL inactive: no interference
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const toolInput = data.tool_input || data.toolInput || {};

  // --- #236 A1 part 1: record decomposer dispatch when the orchestrator
  // calls Agent(subagent_type='mpl-decomposer'). The state flag is
  // consumed by the decomposition.yaml writer-identity check below
  // when the decomposer subsequently calls Write/Edit.
  if (isTaskTool) {
    const sub = String(toolInput.subagent_type || toolInput.subagentType || '');
    if (DECOMPOSER_SUBAGENT_TYPES.has(sub)) {
      // The transcript_path on a PreToolUse Task dispatch is the
      // DISPATCHING agent's transcript (the orchestrator's). Pin it
      // so the writer-identity check can reject any future write
      // arriving with the same transcript_path.
      const parentTranscript = typeof data.transcript_path === 'string'
        ? data.transcript_path
        : (typeof data.transcriptPath === 'string' ? data.transcriptPath : null);
      recordDecomposerDispatch(cwd, parentTranscript);
    }
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // --- Bash dangerous command check (T-01, v3.8) + #236 A3 ---
  if (isBashTool) {
    const command = toolInput.command || '';
    // Claude r11 on PR #249 [security]: Claude r9's
    // decomposer_dispatch forgery guard only covered Write/Edit.
    // A Bash command like
    //   `echo '{"decomposer_dispatch":…}' > .mpl/state.json`
    //   `tee .mpl/state.json <<EOF …`
    //   `dd of=.mpl/state.json …`
    //   `node -e 'fs.writeFileSync(".mpl/state.json", …)'`
    // can still plant the flag through the Bash tool surface.
    // Refuse any Bash command that mentions BOTH `.mpl/state.json`
    // AND `decomposer_dispatch`. The MPL hook is the only legitimate
    // writer of that key — no shell command should ever co-mention
    // them.
    if (/\.mpl\/state\.json/.test(command) && /decomposer_dispatch/.test(command)) {
      const reason =
        `[MPL #236 A1] Refused Bash that mentions both .mpl/state.json AND ` +
        `decomposer_dispatch — only mpl-write-guard itself may plant that flag. ` +
        `Allowing this would let the orchestrator forge the decomposition.yaml ` +
        `writer-identity check.`;
      recordBlockedHook(cwd, {
        hookId: HOOK_ID,
        phaseId: (readState(cwd) || {}).current_phase,
        artifact: '.mpl/state.json',
        code: 'decomposer_dispatch_forgery',
        reason,
        resumeInstruction:
          `Remove the decomposer_dispatch reference from the Bash command. The hook will populate it on Agent(subagent_type='mpl-decomposer') dispatch.`,
        retryContext: { command },
      });
      console.log(JSON.stringify({
        continue: false,
        decision: 'block',
        reason,
      }));
      return;
    }
    // #236 A3: protected-path delete — hard-block regardless of safe-cleanup
    // allowlist. Override via env MPL_FORCE_PURGE=1 set by the operator.
    const protectedTarget = matchesProtectedDelete(command, cwd);
    if (protectedTarget && process.env.MPL_FORCE_PURGE !== '1') {
      const reason =
        `[MPL #236 A3] Refused destructive write to protected path "${protectedTarget}". ` +
        `Command: \`${command}\`. The mpl-cancel skill (skills/mpl-cancel/SKILL.md) forbids ` +
        `deleting any of: ${PROTECTED_DELETE_TARGETS.join(', ')} (decomposition / contracts / ` +
        `cross-session memory / learnings). If you are running a real reset, set MPL_FORCE_PURGE=1 ` +
        `in the same shell, OR invoke /mpl:mpl-cancel which performs an auditable cleanup.`;
      const state = readState(cwd) || {};
      recordBlockedHook(cwd, {
        hookId: HOOK_ID,
        phaseId: state?.current_phase,
        artifact: protectedTarget,
        code: 'protected_path_delete',
        reason,
        resumeInstruction:
          `Either run /mpl:mpl-cancel (auditable cleanup that preserves intended state) or set MPL_FORCE_PURGE=1 in the same shell if you really want this rm to proceed, then retry.`,
        retryContext: { command, target: protectedTarget },
      });
      console.log(JSON.stringify({
        continue: false,
        decision: 'block',
        reason,
      }));
      return;
    }
    if (isDangerousBashCommand(command)) {
      const message = `[MPL SAFETY WARNING] Potentially dangerous command detected:
  ${command}

This command may cause irreversible changes. If this is intentional (e.g., cleanup),
ensure you have the correct target path. The command will proceed, but please verify.`;

      console.log(JSON.stringify({
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: message
        }
      }));
      return;
    }
    // Safe Bash command: allow silently
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // --- Edit/Write source file guard (P0-3, #111) ---
  // Extract file path
  const filePath = toolInput.file_path || toolInput.filePath || '';

  if (!filePath) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const state = readState(cwd) || {};
  const dogfood = isDogfoodMode(cwd);

  // Claude r9 on PR #249 [security]: reject any Write/Edit to
  // .mpl/state.json whose payload introduces or mutates the
  // `decomposer_dispatch.*` key. Only this hook is allowed to set
  // the dispatch flag; an orchestrator that plants a forged flag
  // could otherwise unlock the A1 writer-identity check and Write
  // decomposition.yaml from its own transcript.
  if (STATE_FILE_REGEX.test(filePath)) {
    const payload = (() => {
      const t = data.tool_input || data.toolInput || {};
      const parts = [];
      if (typeof t.content === 'string') parts.push(t.content);
      if (typeof t.new_string === 'string') parts.push(t.new_string);
      if (typeof t.newString === 'string') parts.push(t.newString);
      if (Array.isArray(t.edits)) {
        for (const e of t.edits) {
          if (e?.new_string) parts.push(String(e.new_string));
          if (e?.newString) parts.push(String(e.newString));
        }
      }
      return parts.join('\n');
    })();
    if (DECOMPOSER_DISPATCH_FIELD_REGEX.test(payload)) {
      const reason =
        `[MPL #236 A1] Refused to Write/Edit decomposer_dispatch into ` +
        `.mpl/state.json: only mpl-write-guard itself may set that key. ` +
        `Planting it from outside would let the orchestrator forge the ` +
        `decomposition.yaml writer-identity flag.`;
      recordBlockedHook(cwd, {
        hookId: HOOK_ID,
        phaseId: state?.current_phase,
        artifact: filePath,
        code: 'decomposer_dispatch_forgery',
        reason,
        resumeInstruction:
          `Remove the decomposer_dispatch field from the .mpl/state.json patch; the hook will populate it on Agent(subagent_type='mpl-decomposer') dispatch.`,
        retryContext: { file_path: filePath },
      });
      console.log(JSON.stringify({
        continue: false,
        decision: 'block',
        reason,
      }));
      return;
    }
  }

  // #236 A1: decomposition.yaml may ONLY be Written/Edited by the
  // mpl-decomposer subagent. The hook detects this via a dispatch
  // flag set when the orchestrator calls Agent(subagent_type=
  // 'mpl-decomposer') above; the flag has a 30-min TTL so a stale
  // marker can't permanently unlock the path. Any Write/Edit to
  // decomposition.yaml without an active dispatch — even from
  // inside another subagent — is blocked. The block precedes the
  // generic `isAllowedPath` (.mpl/* is otherwise an allowlisted
  // orchestrator path) so the writer identity wins.
  if (DECOMPOSITION_FILE_REGEX.test(filePath)) {
    const callerTranscript = typeof data.transcript_path === 'string'
      ? data.transcript_path
      : (typeof data.transcriptPath === 'string' ? data.transcriptPath : null);
    if (!isDecomposerDispatchActive(state, callerTranscript)) {
      const reason =
        `[MPL #236 A1] Refused direct ${toolName} of decomposition.yaml: ` +
        `the orchestrator must NOT write this file. Only the mpl-decomposer ` +
        `subagent may emit it (commands/mpl-run-decompose.md). Dispatch via ` +
        `Agent(subagent_type='mpl-decomposer', prompt='...') and let it write.`;
      recordBlockedHook(cwd, {
        hookId: HOOK_ID,
        phaseId: state?.current_phase,
        artifact: filePath,
        code: 'decomposition_writer_violation',
        reason,
        resumeInstruction:
          `Dispatch Agent(subagent_type='mpl-decomposer') and let it produce decomposition.yaml; do not Edit/Write it directly.`,
        retryContext: { file_path: filePath, tool: toolName },
      });
      console.log(JSON.stringify({
        continue: false,
        decision: 'block',
        reason,
      }));
      return;
    }
    // Decomposer dispatch is active for THIS caller — lock the child
    // transcript on first write so a third party can't reuse the
    // window, then allow + clear any stale envelope.
    lockDecomposerChild(cwd, callerTranscript);
    clearBlockedHook(cwd, { hookId: HOOK_ID, artifact: filePath });
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Check if path is allowed for orchestrator (honours dogfood mode).
  if (isAllowedPath(filePath, { dogfood })) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Check if it's a source file → resolve direct_source_edit policy.
  if (isSourceFile(filePath)) {
    const action = resolveRuleAction(cwd, state, 'direct_source_edit');
    if (action === 'off') {
      // Codex r2 on PR #246: explicit opt-out must clear any stale
      // envelope from a prior block for the same (hookId, filePath).
      clearBlockedHook(cwd, { hookId: HOOK_ID, artifact: filePath });
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }
    const dogfoodTag = dogfood ? ' [dogfood mode: MPL/ also enforced]' : '';
    const message = `[MPL DELEGATION NOTICE] Direct ${toolName} on source file: ${filePath}${dogfoodTag}

Source files should be edited by mpl-phase-runner agents, not the orchestrator.
Delegate via: Agent(subagent_type="mpl-phase-runner", prompt="Edit ${filePath} to ...")`;

    if (action === 'block') {
      recordBlockedHook(cwd, {
        hookId: HOOK_ID,
        phaseId: state?.current_phase,
        artifact: filePath,
        code: 'direct_source_edit',
        reason: message,
        resumeInstruction:
          'Delegate the source-file edit to an mpl-phase-runner agent (Agent(subagent_type=mpl-phase-runner, ...)), then retry.',
        retryContext: { file_path: filePath, tool: toolName },
      });
      console.log(JSON.stringify({
        decision: 'block',
        reason: message,
      }));
      return;
    }
    // warn (transitional default)
    clearBlockedHook(cwd, { hookId: HOOK_ID, artifact: filePath });
    console.log(JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: message,
      },
    }));
    return;
  }

  // --- Phase-Scoped File Lock (T-01 Phase 2, v3.9; P0-3 wiring) ---
  // Check if the file is within the current phase's declared scope.
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
            // Codex r2 on PR #246: explicit opt-out must clear any
            // stale envelope from a prior phase_scope_violation block.
            clearBlockedHook(cwd, { hookId: HOOK_ID, artifact: filePath });
            console.log(JSON.stringify({ continue: true, suppressOutput: true }));
            return;
          }
          const message = `[MPL SCOPE WARNING] File "${filePath}" is outside phase "${currentPhase}" scope.
Declared scope files: ${scope.allowed.slice(0, 5).join(', ')}${scope.allowed.length > 5 ? ` (+${scope.allowed.length - 5} more)` : ''}

This may cause cross-phase side effects. Verify this modification belongs in the current phase.`;

          if (action === 'block') {
            recordBlockedHook(cwd, {
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
            });
            console.log(JSON.stringify({
              decision: 'block',
              reason: message,
            }));
            return;
          }
          // warn
          clearBlockedHook(cwd, { hookId: HOOK_ID, artifact: filePath });
          console.log(JSON.stringify({
            continue: true,
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              additionalContext: message,
            },
          }));
          return;
        }
      }
    }
  } catch {
    // Phase scope check failure: fail-open (don't block on parser errors)
  }

  // All checks passed: allow. Codex r2 on PR #246: a write that
  // passes both direct_source_edit AND phase_scope_violation means
  // any envelope previously recorded for THIS (HOOK_ID, filePath) is
  // resolved — clear it so mpl-recover/BLOCKED_HOOK_STALE see the
  // unblocked state.
  if (filePath) {
    clearBlockedHook(cwd, { hookId: HOOK_ID, artifact: filePath });
  }
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

main().catch(() => {
  // On error: allow (fail-open for safety)
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
});

export { isAllowedPath, isSourceFile, isDangerousBashCommand, isDogfoodMode };
