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

import { dirname, join, extname, resolve as resolvePath, basename, posix as posixPath } from 'path';

// Claude r20 on PR #249 [security]: POSIX path resolution collapses
// `//` and `/./` segments at write time. The orchestrator can plant
// `.mpl//mpl/decomposition.yaml` or `.mpl/./state.json` and the
// protected-file regex (which requires single slashes) misses it.
// Normalize the file_path before every protected-file regex check.
function normalizeFilePath(p) {
  if (typeof p !== 'string' || !p) return p;
  return posixPath.normalize(p);
}
import { existsSync, realpathSync } from 'fs';
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
// Claude r21 [security]: macOS APFS / Windows NTFS are case-insensitive
// by default. `.MPL/MPL/decomposition.yaml` opens the same inode as
// the lowercase form. Use case-insensitive regex so the orchestrator
// can't bypass via uppercase. All regex literals are lowercase ASCII
// so the `i` flag is structurally safe.
const DECOMPOSITION_FILE_REGEX = /(^|\/)\.mpl\/mpl\/decomposition\.ya?ml$/i;

// Claude r9 on PR #249 [security]: the orchestrator can Write
// `.mpl/state.json` (it sits inside the `/\.mpl\//` allowlist), and
// the writer-identity check at A1 trusted whatever
// `state.decomposer_dispatch.parent_transcript_path` value it found
// — so the orchestrator could plant a `parent_transcript_path !=
// its own transcript`, then write decomposition.yaml. Reject any
// Write/Edit to .mpl/state.json whose payload introduces or mutates
// `decomposer_dispatch.*` — only the hook itself may set those keys.
const STATE_FILE_REGEX = /(^|\/)\.mpl\/state\.json$/i;
const DECOMPOSER_DISPATCH_FIELD_REGEX = /"decomposer_dispatch"\s*:/;
// Codex r12 + Claude r12 [security]: also protect first_transcript_seen
// from forgery — that key is the bootstrap of the dispatcher-identity
// chain. If the orchestrator plants this field, the codex r12
// mitigation falls. Same guard shape as decomposer_dispatch.
const FIRST_TRANSCRIPT_FIELD_REGEX = /"first_transcript_seen"\s*:/;
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

// Claude r12 on PR #249 [security]: extract the shell-normalization
// chain so other Bash defenses (decomposer_dispatch forgery) can
// reuse it. Without normalization, quote-concat / backslash-escape /
// ANSI-C / slash-collapse forms of `.mpl/state.json` bypassed the
// raw substring check at the dispatch-forgery guard.
function normalizeShellCommand(command) {
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
    // Codex r21 [security]: collapse `/./` segments. POSIX collapses
    // these at path-resolution time, so `.mpl/./state.json` and
    // `.mpl/./mpl/decomposition.yaml` are equivalent to the canonical
    // form. Iterate until no more match (handles `/././`).
    .replace(/\/(?:\.\/)+/g, '/');
  // Claude r22 [security]: iterate `/X/../` collapse until no more
  // matches. Multi-level traversal `.mpl/a/b/../../state.json` was
  // depth-only-one with the single-pass r21 fix.
  let prevNormalized;
  do {
    prevNormalized = normalized;
    normalized = normalized.replace(/\/[^/]+\/\.\.(?:\/|$)/g, '/');
  } while (normalized !== prevNormalized);
  normalized = expandShellBraces(normalized);
  normalized = expandSimpleVars(normalized);
  return normalized;
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
    // Claude r17 on PR #249 [security]: `ln -s SRC DST` creating a
    // symlink whose source is a protected root/descendant lets a
    // later redirect-write reach the protected file through
    // indirection. Catch the creation step itself.
    /\bln\b/.test(normalized) ||
    // Codex r11 on PR #249 [data-integrity]: `tar --remove-files` and
    // `rsync --remove-source-files` are destructive — both delete
    // their source operand after the copy completes.
    /\btar\b.*--remove-files\b/.test(normalized) ||
    /\brsync\b.*--remove-source-files\b/.test(normalized) ||
    // Codex r22 [security]: `rsync --delete` (and variants
    // --delete-before/-during/-delay/-after) prunes the destination
    // tree, removing files not in the source. Same destructive shape
    // as --remove-source-files but against the destination operand.
    /\brsync\b.*--delete(?:-before|-during|-delay|-after)?\b/.test(normalized) ||
    // Claude r23 [security]: `git clean -fdx` / `-fdX` deletes
    // untracked + ignored files. .mpl/ is typically gitignored, so
    // -x sweeps the entire .mpl/ tree. Treat git clean with any -*x*
    // / -*X* flag as destructive against the workspace.
    /\bgit\s+clean\b.*-\S*[xX]/.test(normalized) ||
    // Claude r24 [security]: gzip / bzip2 / xz / zstd delete their
    // input file by default (unless `-k`/`--keep` is set). Treat
    // them as destructive against the operand path.
    //
    // Claude r25 [security]: scan per-statement — `-k`/`--keep`
    // anywhere else in the command doesn't suppress an unkeyed
    // gzip earlier in the chain.
    normalized.split(/[;|&\n]+/).some((seg) => {
      if (!/\b(gzip|bzip2|xz|zstd)\b/.test(seg)) return false;
      // Codex r26 [security]: `-k`/`--keep` only counts as an option
      // when it appears BEFORE `--` (POSIX end-of-options sentinel).
      // After `--` any `-k` is a literal filename. So `gzip -- .mpl/mpl/-k`
      // still deletes the protected file. Split the segment at `--` and
      // only inspect the pre-options portion for the keep flag.
      const beforeDoubleDash = seg.split(/\s--(?:\s|$)/)[0];
      return !/(?:-k|--keep)\b/.test(beforeDoubleDash);
    }) ||
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

  // Codex r23 [security]: runtime-constructed paths via
  // command-substitution + decoder bypass the literal substring
  // check (`p=$(base64 -d ...); rm -rf "$p"`). Conservatively block
  // destructive commands that combine a decoder primitive
  // (base64 / xxd / openssl base64 -d) with command-substitution
  // operand syntax. MPL_FORCE_PURGE=1 escape applies.
  const hasDecoder = /\bbase64\b|\bxxd\b|\bopenssl\s+base64\b/.test(normalized);
  const hasCmdSub = /\$\(|`/.test(normalized);
  if (hasDecoder && hasCmdSub) {
    return PROTECTED_DELETE_TARGETS[0];
  }

  // Claude r23 [security]: `git clean -*x*` sweeps cwd-wide, deleting
  // untracked + (with -x) ignored files. .mpl/ is typically gitignored.
  // Block unconditionally when this verb is present in the command —
  // the operator override via MPL_FORCE_PURGE is the documented
  // escape for legitimate "reset my repo" flows.
  if (/\bgit\s+clean\b.*-\S*[xX]/.test(normalized)) {
    return PROTECTED_DELETE_TARGETS[0];
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
    if (/^(rm|find|sudo|time|nice|env|cd|pushd|popd|mkdir|mv|shred|unlink|truncate|cp|export|tee|dd|tar|rsync|echo|cat|printf|ln)$/i.test(token)) continue;

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
      //
      // Refinement after r24 regression: the ancestor match must
      // only fire when the operand is INSIDE the workspace cwd —
      // otherwise `cd /tmp && …` (with cwd `/tmp/X`) trips because
      // `/tmp` is a filesystem-level ancestor of `/tmp/X/.mpl/mpl`.
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

// Codex r12 on PR #249 [security]: the A1 dispatch gate trusted any
// Task caller as the dispatch parent. A non-orchestrator agent
// (phase-runner, etc.) could dispatch mpl-decomposer and the
// orchestrator could then become the first "child" writer.
//
// Mitigation: bind the dispatcher-role to the FIRST transcript
// observed in the session. The first tool call records
// state.first_transcript_seen; subsequent Task(subagent_type=
// 'mpl-decomposer') calls only record dispatch when the caller's
// transcript matches that first observed transcript. Nested
// dispatchers fail the match and are refused.
function recordFirstTranscript(cwd, transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return;
  try {
    const state = readState(cwd) || {};
    if (typeof state.first_transcript_seen === 'string' && state.first_transcript_seen) return;
    writeState(cwd, { first_transcript_seen: transcriptPath });
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

  const cwd = data.cwd || data.directory || process.cwd();

  // Claude r13 on PR #249 [security]: refuse direct Write/Edit to
  // .mpl/state.json BEFORE the isMplActive short-circuit. Without
  // this, an attacker can deactivate MPL via a benign-looking
  // state.json write, then forge dispatch fields in a second write
  // while the hook short-circuits, then write decomposition.yaml
  // from the orchestrator's own transcript.
  if (isWriteTool && process.env.MPL_FORCE_PURGE !== '1') {
    const earlyFilePath = (data.tool_input || data.toolInput || {}).file_path
      || (data.tool_input || data.toolInput || {}).filePath
      || '';
    // isMplDir: workspace has the .mpl/ directory (regardless of
    // current_phase). This guards the deactivation chain even when
    // current_phase has been flipped to completed/cancelled.
    const isMplDir = existsSync(join(cwd, '.mpl'));

    // Claude r14 on PR #249 [security]: also move the decomposition.yaml
    // writer-identity check BEFORE the isMplActive short-circuit. The
    // r13 state.json guard alone is insufficient because an attacker
    // can deactivate MPL via Bash (command-substitution + cd + bare
    // filename redirect bypasses the static normalize) and then
    // direct-Write decomposition.yaml — the post-isMplActive
    // writer-identity check never runs. Apply the same pre-active
    // guard shape used by the state.json early-return.
    if (earlyFilePath && DECOMPOSITION_FILE_REGEX.test(normalizeFilePath(earlyFilePath)) && isMplDir) {
      const earlyState = readState(cwd) || {};
      const earlyCallerTranscript = typeof data.transcript_path === 'string'
        ? data.transcript_path
        : (typeof data.transcriptPath === 'string' ? data.transcriptPath : null);
      if (!isDecomposerDispatchActive(earlyState, earlyCallerTranscript)) {
        const reason =
          `[MPL #236 A1] Refused direct ${toolName} of decomposition.yaml: ` +
          `only the mpl-decomposer subagent may emit this file. ` +
          `Dispatch via Agent(subagent_type='mpl-decomposer', prompt='...') ` +
          `and let it write.`;
        recordBlockedHook(cwd, {
          hookId: HOOK_ID,
          phaseId: earlyState?.current_phase,
          artifact: earlyFilePath,
          code: 'decomposition_writer_violation',
          reason,
          resumeInstruction:
            `Dispatch Agent(subagent_type='mpl-decomposer') and let it produce decomposition.yaml; do not Edit/Write it directly.`,
          retryContext: { file_path: earlyFilePath, tool: toolName },
        });
        console.log(JSON.stringify({
          continue: false,
          decision: 'block',
          reason,
        }));
        return;
      }
    }

    if (earlyFilePath && STATE_FILE_REGEX.test(normalizeFilePath(earlyFilePath)) && isMplDir) {
      const reason =
        `[MPL #236 A1] Refused direct ${toolName} of .mpl/state.json: only ` +
        `mpl-write-guard's internal writeState may modify the orchestrator ` +
        `state file. Direct Write/Edit can be chained (deactivate MPL → ` +
        `forge decomposer_dispatch → write decomposition.yaml) to bypass ` +
        `the A1 writer-identity gate. Use mpl_state_write / writeState, OR ` +
        `set MPL_FORCE_PURGE=1 in the same shell for a one-shot manual edit.`;
      recordBlockedHook(cwd, {
        hookId: HOOK_ID,
        phaseId: (readState(cwd) || {}).current_phase,
        artifact: earlyFilePath,
        code: 'state_json_direct_write',
        reason,
        resumeInstruction:
          `Route the change through writeState() / mpl_state_write. Set MPL_FORCE_PURGE=1 only for a one-shot manual reset.`,
        retryContext: { file_path: earlyFilePath, tool: toolName },
      });
      console.log(JSON.stringify({
        continue: false,
        decision: 'block',
        reason,
      }));
      return;
    }
  }

  // Codex r16 on PR #249 [security]: also gate Bash writes to
  // .mpl/mpl/decomposition.yaml BEFORE the isMplActive short-circuit.
  // The Write/Edit pre-active guard above doesn't cover Bash.
  // Without this, `printf forged > .mpl/mpl/decomposition.yaml` runs
  // against a deactivated workspace and overwrites the
  // decomposer-owned artifact through shell redirection.
  if (isBashTool && process.env.MPL_FORCE_PURGE !== '1') {
    const earlyCommand = (data.tool_input || data.toolInput || {}).command || '';
    if (earlyCommand && existsSync(join(cwd, '.mpl'))) {
      // Claude r21 [security]: lowercase for case-insensitive filesystem
      // protection. macOS APFS / Windows NTFS open `.MPL/...` against
      // the same inode as `.mpl/...`. All subsequent regexes match
      // lowercase ASCII so lowercasing the input is structurally safe.
      const normalizedEarly = normalizeShellCommand(earlyCommand).toLowerCase();
      // Codex r24 [security]: detect `cd …` followed by a redirect/tee/
      // dd-of to a bare basename matching a protected file. Static
      // checks can't model directory changes, so a command like
      // `cd .$(printf mpl)/mpl && printf forged > decomposition.yaml`
      // would otherwise slip — after the cd, `decomposition.yaml` is
      // resolved against the new cwd. Treat the combination as a
      // protected write.
      const hasCdCmdSub = /\bcd\b[^;|&\n]*\$\(/.test(normalizedEarly) ||
                          /\bcd\b[^;|&\n]*`/.test(normalizedEarly);
      const hasCdBareDecompWrite = /\bcd\b[\s\S]*&&[\s\S]*(?:>{1,2}|\btee\b|\bdd\b[^;|&]*\bof=)\s*decomposition\.ya?ml\b/i.test(normalizedEarly);
      const cdConstructedDecomp = hasCdCmdSub && /(?:>{1,2}|\btee\b|\bdd\b[^;|&]*\bof=)\s*decomposition\.ya?ml\b/i.test(normalizedEarly);
      let decompMention = /\.mpl\/mpl\/decomposition\.ya?ml/i.test(normalizedEarly)
                          || hasCdBareDecompWrite || cdConstructedDecomp;
      // Claude r17 [security]: also resolve redirect/tee/dd-of target
      // paths through symlinks. A pre-existing symlink whose target
      // resolves to `.mpl/mpl/...` defeats the literal substring check.
      let symlinkWritesToDecomp = false;
      if (!decompMention) {
        // Claude r18 [security]: iterate EVERY redirect/tee/dd-of
        // target in the command, not just the first. A multi-statement
        // line with a benign first redirect followed by a symlink-
        // through-protected second redirect would otherwise slip.
        //
        // Claude r19 [security]: the tee alternation was greedy and
        // swallowed the path itself via regex backtracking. Anchor
        // tee's capture group AFTER any flag tokens: `tee (-X)* PATH`.
        const targetRe = /(?:[\d&]?>{1,2}\s*|\btee\b(?:\s+-\S+)*\s+|\bdd\b[^|;&]*\bof=\s*)([^\s|;&]+)/g;
        for (const m of normalizedEarly.matchAll(targetRe)) {
          const target = m[1];
          const targetAbs = resolvePath(cwd, target);
          // Try the WHOLE target first (catches the case where the
          // target itself is a symlink to a protected file). Fall back
          // to realpath(dirname) if the target doesn't exist yet.
          let candidate = null;
          try { candidate = realpathSync(targetAbs); }
          catch {
            try { candidate = join(realpathSync(dirname(targetAbs)), basename(targetAbs)); }
            catch { /* parent doesn't exist — skip */ }
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
        // Codex r19 [security]: check EVERY pipeline / statement
        // segment's head verb, not just the first. `printf forged |
        // sponge .mpl/mpl/decomposition.yaml` has a safe-read head
        // (`printf`) but a downstream writer (`sponge`) that
        // overwrites the protected file.
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
          recordBlockedHook(cwd, {
            hookId: HOOK_ID,
            phaseId: (readState(cwd) || {}).current_phase,
            artifact: '.mpl/mpl/decomposition.yaml',
            code: 'decomposition_bash_write',
            reason,
            resumeInstruction:
              `Dispatch Agent(subagent_type='mpl-decomposer'); do not write decomposition.yaml from Bash.`,
            retryContext: { command: earlyCommand },
          });
          console.log(JSON.stringify({
            continue: false,
            decision: 'block',
            reason,
          }));
          return;
        }
      }
    }
  }

  // Codex r20 on PR #249 [security]: also gate Bash writes to
  // .mpl/state.json BEFORE the isMplActive short-circuit. Without
  // this, the deactivation-chain class re-opens for Bash:
  // current_phase=completed lets a Bash redirect write a forged
  // decomposer_dispatch into state.json. Mirrors the decomp guard
  // above and the r13 state.json Write/Edit guard.
  if (isBashTool && process.env.MPL_FORCE_PURGE !== '1') {
    const earlyCommand = (data.tool_input || data.toolInput || {}).command || '';
    if (earlyCommand && existsSync(join(cwd, '.mpl'))) {
      // Claude r21 [security]: lowercase for case-insensitive filesystem
      // protection. macOS APFS / Windows NTFS open `.MPL/...` against
      // the same inode as `.mpl/...`. All subsequent regexes match
      // lowercase ASCII so lowercasing the input is structurally safe.
      const normalizedEarly = normalizeShellCommand(earlyCommand).toLowerCase();
      const SAFE_READS_EARLY = new Set([
        'cat', 'ls', 'head', 'tail', 'wc', 'file', 'stat', 'du', 'df',
        'grep', 'rg', 'ag', 'ack', 'jq', 'yq',
        'less', 'more', 'sort', 'uniq', 'tac', 'nl',
        'diff', 'comm', 'sdiff',
        'echo', 'printf', 'pwd', 'type', 'which',
      ]);
      // Codex r24 [security]: detect cd-into-constructed-mpl + bare
      // state.json write.
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
          recordBlockedHook(cwd, {
            hookId: HOOK_ID,
            phaseId: (readState(cwd) || {}).current_phase,
            artifact: '.mpl/state.json',
            code: 'state_json_bash_write',
            reason,
            resumeInstruction:
              `Route the change through writeState(); set MPL_FORCE_PURGE=1 only for a one-shot manual reset.`,
            retryContext: { command: earlyCommand },
          });
          console.log(JSON.stringify({
            continue: false,
            decision: 'block',
            reason,
          }));
          return;
        }
      }
    }
  }

  // Check if MPL is active
  if (!isMplActive(cwd)) {
    // MPL inactive: no interference
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const toolInput = data.tool_input || data.toolInput || {};
  const callerTranscriptPath = typeof data.transcript_path === 'string'
    ? data.transcript_path
    : (typeof data.transcriptPath === 'string' ? data.transcriptPath : null);

  // Codex r12 on PR #249 [security]: record the FIRST transcript
  // observed in the session on EVERY tool call (Bash / Write / Task /
  // etc.) — this binds the dispatcher-role to whichever transcript
  // appears first, which is typically the orchestrator. Subsequent
  // mpl-decomposer dispatches from OTHER transcripts (nested
  // phase-runner, etc.) are then refused.
  recordFirstTranscript(cwd, callerTranscriptPath);

  // --- #236 A1 part 1: record decomposer dispatch when the orchestrator
  // calls Agent(subagent_type='mpl-decomposer'). The state flag is
  // consumed by the decomposition.yaml writer-identity check below
  // when the decomposer subsequently calls Write/Edit.
  if (isTaskTool) {
    const sub = String(toolInput.subagent_type || toolInput.subagentType || '');
    if (DECOMPOSER_SUBAGENT_TYPES.has(sub)) {
      const sessState = readState(cwd) || {};
      const firstSeen = typeof sessState.first_transcript_seen === 'string'
        ? sessState.first_transcript_seen
        : null;
      // Codex r12 [security]: only the first-seen (orchestrator-role)
      // transcript may dispatch mpl-decomposer. Any other caller's
      // dispatch is refused (no dispatch flag recorded → no
      // decomposition.yaml write window opens).
      if (firstSeen && callerTranscriptPath && firstSeen === callerTranscriptPath) {
        recordDecomposerDispatch(cwd, callerTranscriptPath);
      }
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
    // Claude r12 [security]: normalize the command through the same
    // layered shell decode as matchesProtectedDelete BEFORE the
    // substring check, so quote-concat / backslash-escape / ANSI-C /
    // slash-collapse forms of `.mpl/state.json` can't bypass.
    // Claude r21 [security]: lowercase for case-insensitive filesystem
    // protection (macOS APFS / Windows NTFS).
    const normalizedCommand = normalizeShellCommand(command).toLowerCase();
    // Codex r13 on PR #249 [security]: an encoded write (e.g. base64
    // -d > .mpl/state.json) can plant decomposer_dispatch without the
    // literal field name appearing in the Bash command. The right
    // structural fix is to refuse ANY Bash command that writes to
    // .mpl/state.json — the hook itself uses writeState() (not Bash)
    // so legit hook operation is unaffected. MPL_FORCE_PURGE=1 is the
    // documented escape hatch for legitimate manual state edits.
    //
    // Detection: command mentions `.mpl/state.json` (in normalized
    // form) AND has any destructive verb / redirect / interpreter
    // (the same `isDestructive` indicator matchesProtectedDelete
    // uses). Read-only operations against state.json (`cat .mpl/
    // state.json`, `ls .mpl/state.json`) still pass.
    const stateJsonMention = /\.mpl\/state\.json/.test(normalizedCommand);
    // Codex r14 on PR #249 [security]: a verb allowlist is unbounded.
    // Structural rule: state.json is presumed-write UNLESS the head
    // verb is in SAFE_READ_HEADS AND the command does not redirect /
    // tee / dd-of into state.json. This catches pipeline forms like
    // `printf X | base64 -d > .mpl/state.json` (head safe but redirect
    // target is state.json) AND novel writer utilities (install / pax /
    // cpio / touch / mktemp / etc., head not safe-read).
    // Codex r15 on PR #249 [security]: removed `find` from the
    // safe-read set. `find .mpl/state.json -exec sh -c 'echo forged
    // > "$1"' _ {} \;` would otherwise pass — `find` head is safe-
    // read but `-exec` invokes arbitrary shell that writes via a
    // runtime-substituted `{}` operand which the static regex check
    // can't see.
    const SAFE_READ_HEADS = new Set([
      'cat', 'ls', 'head', 'tail', 'wc', 'file', 'stat', 'du', 'df',
      'grep', 'rg', 'ag', 'ack',
      'jq', 'yq',
      'less', 'more',
      'sort', 'uniq', 'tac', 'nl',
      'diff', 'comm', 'sdiff',
      'echo', 'printf', 'pwd', 'type', 'which',
    ]);
    // Codex r19 [security]: check EVERY pipeline / statement segment's
    // head verb, not just the first. `printf forged | sponge
    // .mpl/state.json` has a safe-read head but a downstream writer.
    const segmentsStateGuard = normalizedCommand
      .split(/[|;&]+/).map((s) => s.trim()).filter(Boolean);
    const isSafeRead = segmentsStateGuard.length > 0 && segmentsStateGuard.every((seg) => {
      const segHead = (seg.match(/^(\w+)/) || ['', ''])[1].toLowerCase();
      return SAFE_READ_HEADS.has(segHead);
    });
    // Detect redirect/tee/dd targeting state.json anywhere in the
    // command (catches pipe-then-redirect forms).
    let writesToStateJson = (
      /[\d&]?>{1,2}[^|;&\n]*\.mpl\/state\.json/.test(normalizedCommand) ||
      /\btee\b[^|;&]*\.mpl\/state\.json/.test(normalizedCommand) ||
      /\bdd\b[^|;&]*\bof=[^|;&]*\.mpl\/state\.json/.test(normalizedCommand)
    );
    // Claude r18 [security] (symmetric to decomp fix): iterate ALL
    // redirect/tee/dd-of targets and realpath-check each so symlink-
    // through-state.json forms (single or multi-statement) are caught.
    let symlinkWritesToStateJson = false;
    if (!stateJsonMention) {
      // Claude r19 [security]: anchor tee's capture after option list.
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
      recordBlockedHook(cwd, {
        hookId: HOOK_ID,
        phaseId: (readState(cwd) || {}).current_phase,
        artifact: '.mpl/state.json',
        code: 'state_json_bash_write',
        reason,
        resumeInstruction:
          `Use the orchestrator's state-write tool path (or the Read+Edit tool if appropriate); set MPL_FORCE_PURGE=1 only if a manual reset is intended.`,
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
  // (state.json Write/Edit guard moved to the top of main() to run
  // BEFORE the isMplActive short-circuit — see Claude r13.)

  // #236 A1: decomposition.yaml may ONLY be Written/Edited by the
  // mpl-decomposer subagent. The hook detects this via a dispatch
  // flag set when the orchestrator calls Agent(subagent_type=
  // 'mpl-decomposer') above; the flag has a 30-min TTL so a stale
  // marker can't permanently unlock the path. Any Write/Edit to
  // decomposition.yaml without an active dispatch — even from
  // inside another subagent — is blocked. The block precedes the
  // generic `isAllowedPath` (.mpl/* is otherwise an allowlisted
  // orchestrator path) so the writer identity wins.
  if (DECOMPOSITION_FILE_REGEX.test(normalizeFilePath(filePath))) {
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
