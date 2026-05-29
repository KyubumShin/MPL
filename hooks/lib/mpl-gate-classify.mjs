import { loadConfig } from './mpl-config.mjs';

/**
 * Shared Bash command → gate-family classifier.
 *
 * AD-0006 / P0-1 (#102): the Hard 1/2/3 gates each expect a specific kind
 * of evidence. We need to know whether a command belongs to:
 *   hard1_baseline   — lint / typecheck / build / compile
 *   hard2_coverage   — unit / integration test runners
 *   hard3_resilience — E2E / contract / a11y / runtime resilience
 *
 * Two consumers use this:
 *  1. `hooks/mpl-gate-recorder.mjs` — to route observed Bash completions
 *     into the matching `gate_results.hardN_*` slot.
 *  2. `hooks/lib/mpl-state-invariant.mjs` (I12 — Exp22 R13 / #209) — to
 *     reject manual state.json writes that put e.g. `git commit ...` into
 *     `hard2_coverage.command`.
 *
 * Returns one of `'hard1_baseline'`, `'hard2_coverage'`,
 * `'hard3_resilience'`, or `null` when no family matches.
 */

const HARD3_PATTERNS = [
  /\bplaywright\b/,
  /\bcypress\b/,
  /\be2e\b/,
  /\bcontract\b/,
  /jest.*\be2e\b/,
  /wdio/,
];

const HARD2_PATTERNS = [
  /\bpnpm\s+(run\s+)?test\b/,
  /\bnpm\s+(run\s+)?test\b/,
  /\byarn\s+(run\s+)?test\b/,
  /\bvitest\b/,
  /\bjest\b/,
  /\bcargo\s+test\b/,
  /\bpytest\b/,
  /\bgo\s+test\b/,
  /\bmocha\b/,
];

const HARD1_PATTERNS = [
  /\bpnpm\s+(run\s+)?lint\b/,
  /\bnpm\s+(run\s+)?lint\b/,
  /\bpnpm\s+(run\s+)?build\b/,
  /\bnpm\s+(run\s+)?build\b/,
  /\bpnpm\s+(run\s+)?typecheck\b/,
  /\btsc\b/,
  /\beslint\b/,
  /\bcargo\s+clippy\b/,
  /\bcargo\s+build\b/,
  /\bcargo\s+check\b/,
  /\bruff\b/,
  /\bmypy\b/,
  /\bgo\s+build\b/,
  /\bgo\s+vet\b/,
];

// Commands whose HEAD (first non-prefix word) is never gate evidence.
// Without this, a `git commit -m "e2e tests done"` would match the
// hard3 `\be2e\b` keyword by accident and slip past I12. We reject the
// command at the head before falling through to family patterns.
const NON_GATE_HEAD_COMMANDS = new Set([
  'git', 'gh', 'echo', 'printf', 'cat', 'ls', 'cd', 'pwd', 'mkdir',
  'rm', 'mv', 'cp', 'touch', 'chmod', 'chown', 'ln',
  'curl', 'wget', 'ping', 'ssh', 'scp', 'rsync',
  'sleep', 'true', 'false',
  'docker', 'kubectl', 'helm',
  'open',
  // Shell wrappers — codex r3 on PR #219 [data-integrity]. A manual
  // gate-evidence write like `bash -lc "git commit -m e2e"` would
  // otherwise classify as hard3_resilience via the embedded `e2e`
  // keyword. The recorder hook never records shell-wrapped commands
  // (it sees the actual command executed); manual writes that go
  // through a wrapper are not credible gate evidence.
  'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh',
  // Shell-evaluation primitives — codex+claude r4 on PR #219. `eval`
  // takes a string and evaluates it as a shell command, the same
  // bypass shape as r3's `bash -c`. Subshell openers `(` are normalized
  // out by extractCommandHead so they reach this set as the inner head.
  'eval',
]);

// Tokens commonly used as prefixes that should be peeled before the
// "head command" check — `sudo npm test` is still a test command.
const COMMAND_PREFIX_TOKENS = new Set(['sudo', 'time', 'nice', 'env', 'exec']);

function extractCommandHead(command) {
  // Find the head program after skipping env-var assignments
  // (FOO=bar npm test) and common prefix tokens (sudo, time). Reduce
  // the head to its BASENAME so path-qualified invocations like
  // `/usr/bin/git` are recognized as `git` against the denylist.
  // Codex r1 on PR #219: without basename reduction, an absolute-path
  // git invocation would bypass the gate-family invariant.
  //
  // Codex+claude r4 on PR #219: subshell/eval prefixes (`(git ...)`,
  // `` `git ...` ``, `$(git ...)`) must also be normalized so the inner
  // head reaches the denylist check. Strip any leading shell-opener
  // characters from the first significant token before basename
  // reduction.
  //
  // Codex r5 on PR #219: after consuming a wrapper prefix token, the
  // next token may be a flag (`sudo -E`, `env -u FOO`, `time -p`,
  // `nice -n 5`). Skip flag tokens (starting with `-`) until we reach
  // a real executable head.
  //
  // This is a heuristic — full shell parsing is out of scope, and the
  // right answer for "command i don't understand" is null (classifier
  // returns null → I12 rejects unclassified entries).
  const tokens = command.trim().split(/\s+/);
  let i = 0;
  let sawPrefix = false;
  while (i < tokens.length) {
    const t = tokens[i];
    if (!t) { i++; continue; }
    // env assignment "VAR=value"
    if (/^[A-Z_][A-Z0-9_]*=/i.test(t)) { i++; continue; }
    const lower = t.toLowerCase();
    if (COMMAND_PREFIX_TOKENS.has(lower)) { sawPrefix = true; i++; continue; }
    // Codex r5: after a wrapper prefix (sudo, env, time, nice, ...),
    // any `-`-prefixed flag token is ambiguous — `-E` takes no value,
    // `-u` takes one, etc. Heuristic flag-value consumption is wrong in
    // both directions. Fail closed: return empty head so the classifier
    // returns null and I12 rejects the entry. Manual gate evidence
    // doesn't need wrapper flags; recorder-produced commands never
    // wrap with flags either, so this denial is safe.
    if (sawPrefix && t.startsWith('-')) {
      return '';
    }
    // Strip leading subshell / eval-opener chars: `(`, `` ` ``, `$(`.
    const stripped = lower
      .replace(/^[`(]+/, '')
      .replace(/^\$\(/, '')
      .replace(/^\.\//, '');
    if (!stripped) { i++; continue; }
    const lastSlash = stripped.lastIndexOf('/');
    return lastSlash === -1 ? stripped : stripped.slice(lastSlash + 1);
  }
  return '';
}

// Strict-mode head allowlist — codex r7 on PR #219 [data-integrity].
// Manual `state.gate_results` writes must use a command whose HEAD is a
// recognized test runner / build tool. Anything else — even with a
// matching family keyword inside an argument (`node -e "npm test"`,
// `python -c "print('e2e')"`) — fails closed. This is much tighter than
// a denylist; it explicitly enumerates the only heads we accept as
// manual gate evidence. The recorder path (`classifyRecordedCommand`)
// still uses regex-only matching to keep wrapper invocations working.
//
// #240 A4: the BUILTIN set covers JS/TS/Python/Rust/Go ecosystems.
// Projects on Bun/Deno/PHP/Swift/.NET/Elixir/etc. extend the set via
// `.mpl/config.json` `gate_classify.allowed_heads: [...]`. Use
// `allowedGateHeads(cwd)` to read the merged set for a given workspace
// (built-in ∪ config extension). The bare `STRICT_GATE_HEAD_ALLOWLIST`
// export remains the built-in canonical reference.
export const STRICT_GATE_HEAD_ALLOWLIST = Object.freeze(new Set([
  // Hard 1 — lint / typecheck / build / compile
  'tsc', 'eslint', 'ruff', 'mypy',
  // Hard 2 — unit / integration test runners
  'vitest', 'jest', 'pytest', 'mocha',
  // Hard 3 — e2e / contract
  'playwright', 'cypress', 'wdio',
  // Package-manager invocations cover most build+test+e2e cases.
  // The family regex still narrows: `npm test` → hard2, `npm run build`
  // → hard1, `npm run test:e2e` → hard3.
  'npm', 'pnpm', 'yarn', 'npx', 'pnpx',
  // Compiled / system languages
  'cargo', 'go',
]));

// #240 A4 + codex r1 on PR #244 [data-integrity]: script interpreters
// take arbitrary text via `-e` / `-c` / etc. that the family regex
// would erroneously match. These heads MUST NOT be admissible as
// strict manual gate evidence even if an operator adds them to
// `.mpl/config.json gate_classify.allowed_heads`. Reject silently at
// the config-read boundary so I12 stays load-bearing.
const STRICT_GATE_HEAD_INTERPRETER_DENYLIST = Object.freeze(new Set([
  'node', 'deno', 'bun', // (deno/bun: CLI runtimes themselves can also `eval`)
  'python', 'python3', 'python2',
  'ruby', 'irb',
  'perl', 'php',
  'awk', 'sed',
  'lua', 'luajit',
  'tclsh', 'expect',
  'osascript',
]));

// #240 A4 + codex r1 on PR #244 [contract-break]: configured heads
// must also map to gate families. The built-in family regex doesn't
// know about ecosystems like `deno test` / `bun test` / `biome ci`,
// so `allowed_heads: ['deno']` alone would pass the head check but
// fail the family classification — defeating the config knob.
//
// Two accepted shapes per entry in
// `.mpl/config.json gate_classify.allowed_heads`:
//   1. plain string: e.g. `"biome"`. Used only for heads whose
//      sub-commands already match the built-in family regex.
//   2. structured object: `{ "head": "deno", "families": {
//          "hard1_baseline": ["check", "lint", "fmt"],
//          "hard2_coverage": ["test"],
//          "hard3_resilience": ["bench", "e2e"]
//      } }`. Each pattern is matched as a token immediately following
//      the head (`deno test`, `bun run test`, etc.).
//
// Entries with an interpreter head are silently dropped — the
// denylist always wins.
function readGateClassifyConfig(cwd) {
  if (!cwd) return { heads: new Set(), structured: new Map() };
  try {
    const cfg = loadConfig(cwd);
    const extra = cfg?.gate_classify?.allowed_heads;
    if (!Array.isArray(extra)) return { heads: new Set(), structured: new Map() };
    const heads = new Set();
    const structured = new Map();
    for (const entry of extra) {
      if (typeof entry === 'string' && entry.trim()) {
        // Plain string entries: must NOT be interpreters. The string
        // form delegates classification entirely to the built-in
        // family regex, which would match arbitrary `-e` / `-c` text.
        const head = entry.trim().toLowerCase();
        if (STRICT_GATE_HEAD_INTERPRETER_DENYLIST.has(head)) continue;
        heads.add(head);
        continue;
      }
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const head = typeof entry.head === 'string' ? entry.head.trim().toLowerCase() : '';
        if (!head) continue;
        // Structured entries: the explicit `families` map enumerates
        // the only sub-commands that count as gate evidence, and the
        // classifier requires the pattern to appear as the next
        // non-flag token after the head (see classifyConfiguredHead).
        // That structurally rejects `deno -e "test"` / `node -e "..."`
        // — interpreter abuse is still blocked, but legitimate
        // `deno test` / `bun test` flows through.
        const families = entry.families && typeof entry.families === 'object' && !Array.isArray(entry.families)
          ? entry.families
          : null;
        if (!families) {
          // No families → demote to plain string semantics with the
          // interpreter check (so a structured entry without families
          // can't bypass the denylist).
          if (STRICT_GATE_HEAD_INTERPRETER_DENYLIST.has(head)) continue;
          heads.add(head);
          continue;
        }
        heads.add(head);
        const familyMap = {};
        for (const familyKey of ['hard1_baseline', 'hard2_coverage', 'hard3_resilience']) {
          const patterns = families[familyKey];
          if (Array.isArray(patterns)) {
            familyMap[familyKey] = patterns
              .filter((p) => typeof p === 'string' && p.trim())
              .map((p) => p.trim().toLowerCase());
          }
        }
        structured.set(head, familyMap);
      }
    }
    return { heads, structured };
  } catch {
    return { heads: new Set(), structured: new Map() };
  }
}

// #240 A4: read .mpl/config.json `gate_classify.allowed_heads` and
// union it with the built-in set. Returns a Set of lowercase string
// heads. Interpreter heads (codex r1 on PR #244) are silently dropped.
export function allowedGateHeads(cwd) {
  const merged = new Set(STRICT_GATE_HEAD_ALLOWLIST);
  const { heads } = readGateClassifyConfig(cwd);
  for (const h of heads) merged.add(h);
  return merged;
}

// Codex r8 on PR #244 [contract-break]: runner-head argument forgery.
// `npx`/`pnpx`/`npm exec` allow arbitrary scripts after the head; the
// family regex naively scanned the whole command, so `npx cowsay
// playwright` matched `\bplaywright\b` and forged hard3 evidence.
//
// Fix: for these runner heads, the FIRST positional (non-flag) token
// after the head IS the script. Only accept the command as gate
// evidence if that script is itself a known gate runner. Anything
// else (cowsay, http-server, install args, etc.) → null.
//
// Recognized runner scripts and their gate family:
const RUNNER_SCRIPT_FAMILIES = new Map([
  ['playwright', 'hard3_resilience'],
  ['cypress', 'hard3_resilience'],
  ['wdio', 'hard3_resilience'],
  ['vitest', 'hard2_coverage'],
  ['jest', 'hard2_coverage'],
  ['mocha', 'hard2_coverage'],
  ['pytest', 'hard2_coverage'],
  ['tsc', 'hard1_baseline'],
  ['eslint', 'hard1_baseline'],
  ['ruff', 'hard1_baseline'],
  ['mypy', 'hard1_baseline'],
  ['biome', 'hard1_baseline'],
]);

// npm/pnpm/yarn subcommands that are NEVER gate evidence even when
// the keyword appears in their args (`npm install playwright` etc.).
const NPM_SUBCOMMANDS_NOT_TEST = new Set([
  'install', 'i', 'add', 'uninstall', 'remove', 'rm', 'un',
  'ci', 'audit', 'view', 'info', 'init', 'publish', 'pack',
  'link', 'unlink', 'outdated', 'update', 'upgrade', 'up',
  'config', 'help', 'doctor', 'whoami', 'token', 'org', 'team',
  'access', 'search', 'fund', 'login', 'logout', 'set',
]);

// npm/pnpm/yarn subcommands that DO execute an arbitrary script — the
// script-name gate applies after consuming the subcommand.
const NPM_EXEC_SUBCOMMANDS = new Set(['exec', 'dlx', 'x']);

// npx flags that take a value (so the next token is NOT the script).
// `-c`/`--call`/`-e`/`--eval`/`-x`/`--exec`/`--run-script` are already
// removed at canonical level by stripAtEvalFlag — no need to repeat.
const NPX_FLAGS_WITH_VALUE = new Set([
  '-p', '--package', '--shell',
  '-w', '--workspace', '--workspaces',
]);

// Returns:
//   string    → recognized runner family (definitive verdict)
//   null      → runner head with unrecognized script → reject (NO regex fallback)
//   undefined → not a runner-style invocation; caller falls through
function classifyRunnerHead(head, canonical) {
  const tokens = String(canonical || '').trim().split(/\s+/);
  let i = 1; // skip the head itself

  if (head === 'npm' || head === 'pnpm' || head === 'yarn') {
    if (i >= tokens.length) return undefined;
    const sub = tokens[i].toLowerCase();
    if (NPM_SUBCOMMANDS_NOT_TEST.has(sub)) return null;
    if (!NPM_EXEC_SUBCOMMANDS.has(sub)) return undefined;
    i++; // consumed exec/dlx/x
  } else if (head !== 'npx' && head !== 'pnpx') {
    return undefined;
  }

  while (i < tokens.length) {
    const t = tokens[i];
    if (!t) { i++; continue; }
    if (t === '--') { i++; continue; }
    if (t.startsWith('-')) {
      const flagKey = t.toLowerCase().split('=')[0];
      if (t.includes('=')) { i++; continue; }
      if (NPX_FLAGS_WITH_VALUE.has(flagKey)) { i += 2; continue; }
      i++;
      continue;
    }
    const stripped = t.toLowerCase()
      .replace(/^[\\$"'`]+/, '')
      .replace(/[\\"'`]+$/, '');
    const basename = stripped.split('/').pop();
    if (RUNNER_SCRIPT_FAMILIES.has(basename)) {
      return RUNNER_SCRIPT_FAMILIES.get(basename);
    }
    return null;
  }
  return null;
}

// #240 A4: classify a (head, canonical_command) against a structured
// configured-head entry. Returns the gate family key (one of
// hard1_baseline / hard2_coverage / hard3_resilience) when a
// subcommand pattern matches; null otherwise. Subcommand match:
// any pattern that appears as a whole token after the head.
function classifyConfiguredHead(head, canonical, structuredMap) {
  const families = structuredMap?.get(head);
  if (!families) return null;
  // The configured pattern MUST be the next non-flag token after the
  // head. Walking the tokens manually (instead of running the pattern
  // against the whole command) blocks `deno -e "test"`-style
  // interpreter abuse: the `-e` is a flag, so `test` inside the
  // quoted argument never reaches the comparison.
  const tokens = String(canonical || '').toLowerCase().trim().split(/\s+/);
  if (tokens.length < 2 || tokens[0] !== head) return null;
  let nextTokenIdx = -1;
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i].startsWith('-')) {
      // Reject as soon as a flag appears between head and pattern —
      // structured-entry gating depends on the immediate subcommand,
      // not on anything after a flag.
      return null;
    }
    nextTokenIdx = i;
    break;
  }
  if (nextTokenIdx === -1) return null;
  const subcommand = tokens[nextTokenIdx];
  for (const familyKey of ['hard3_resilience', 'hard2_coverage', 'hard1_baseline']) {
    const patterns = families[familyKey];
    if (!Array.isArray(patterns)) continue;
    if (patterns.includes(subcommand)) return familyKey;
  }
  return null;
}

/**
 * Strict classifier — used by the I12 state-invariant on manual
 * `state.gate_results` writes. The command's HEAD must be in the
 * strict allowlist of recognized gate-evidence binaries; rejects
 * head-denylisted, empty-head, and wrapper-with-flag forms (codex
 * r1/r3/r4/r5/r7 on PR #219).
 *
 * Recorder events should NOT use this — they need to accept legitimate
 * execution wrappers (`docker compose run app npm test`, `kubectl exec
 * pod -- npm test`, `bash -lc "npm test"`) that the strict path denies.
 * Codex r6 on PR #219 caught the recorder regression. Use
 * `classifyRecordedCommand` for that path.
 *
 * NOTE on the strict / recorder asymmetry (#220 + codex r5/r6/r7 on
 * PR #231): strict and recorder are DELIBERATELY different — strict
 * is for blocking manual masquerade on `state.gate_results`; recorder
 * accepts execution wrappers (docker / bash -lc / kubectl exec). A
 * recorder-produced command with a wrapper head will re-classify as
 * `null` under strict if it ever appears in a STATE_WRITE check, by
 * design: I12 should not re-validate recorder evidence against the
 * stricter manual-write rules. Follow-ups tracking the recorder
 * exit-code-vs-leading-command gap and any I12 / recorder source-of-
 * truth refactor are NOT in this PR.
 */
export function classifyGateCommand(command, { cwd } = {}) {
  if (typeof command !== 'string' || !command.trim()) return null;
  // #220 on PR #231: canonicalize composite/redirect/comment forms
  // via `stripNonExecutedSuffix` so the leading simple command (the
  // one that actually runs) drives both head allowlisting and family
  // matching. Manual masquerade is blocked because:
  //   - The trim cuts at the first control / redirect / comment
  //     boundary, so downstream-keyword payloads never reach the
  //     family regex.
  //   - The head allowlist still applies — `node -e "npm test"` /
  //     `python -c "..."` still null (head not allowlisted), as
  //     does any wrapper head (`docker`, `bash`, `kubectl`).
  //   - The leading simple command's family then drives the
  //     classification; a manual write claiming hard3 with a
  //     leading `npm test` resolves to hard2 → I12 slot mismatch.
  const canonical = stripNonExecutedSuffix(command);
  if (!canonical.trim()) return null;
  const head = extractCommandHead(canonical);
  if (!head) return null;
  if (NON_GATE_HEAD_COMMANDS.has(head)) return null;
  // Codex r7 on PR #219: even with a non-denied head, the head MUST be
  // in the explicit allowlist. `node`, `python`, `ruby`, `perl`, etc.
  // are NOT accepted manual gate evidence because their `-e`/`-c`
  // forms can contain arbitrary text that the family regex would
  // erroneously match.
  // #240 A4 + codex r1/r2 on PR #244:
  //   r1 [data-integrity] — interpreter abuse: a structured entry for
  //     a non-built-in head (e.g. `deno`) must drive classification on
  //     its own. Running matchFamilyRegex against the whole canonical
  //     would happily match keywords inside a `-e "console.log('e2e')"`
  //     literal and forge hard3 evidence. classifyConfiguredHead
  //     walks tokens and rejects flags, so it's safe for new heads.
  //   r2 [contract-break] — structured entries for BUILT-IN heads must
  //     NOT shadow the built-in family regex (otherwise a structured
  //     entry like `{head: 'npm', families: {hard2_coverage: ['test']}}`
  //     would break `npm run lint`'s built-in hard1 classification).
  //     For built-in heads, structured patterns ADD; built-in regex
  //     stays the fallback.
  let structured = null;
  if (cwd) {
    structured = readGateClassifyConfig(cwd).structured;
  }
  const allowed = cwd ? allowedGateHeads(cwd) : STRICT_GATE_HEAD_ALLOWLIST;
  if (!allowed.has(head)) return null;
  const isBuiltIn = STRICT_GATE_HEAD_ALLOWLIST.has(head);
  // Codex r3/r4 on PR #244 [contract-break]: built-in heads like
  // `npx`/`pnpx` accept eval-style flags (`-c`, `--call`) whose
  // string argument the family regex would otherwise match. Strip
  // the canonical at the first eval-shaped flag before ANY regex
  // fallback so `npx -c "echo playwright"` does NOT classify as
  // hard3 via the string-literal keyword — regardless of whether
  // structured config is present.
  const safeCanonical = stripAtEvalFlag(canonical);
  // Codex r8 on PR #244 [contract-break]: for package-runner heads,
  // gate on the FIRST positional script token, not on whole-command
  // regex. `npx cowsay playwright` etc. is rejected because cowsay
  // is not a known gate runner. Structured config still takes
  // precedence (operators can opt-in to non-standard invocations).
  const familyFallback = () => {
    const runnerVerdict = classifyRunnerHead(head, safeCanonical);
    if (runnerVerdict !== undefined) return runnerVerdict;
    return matchFamilyRegex(safeCanonical);
  };
  if (structured?.has(head)) {
    const configured = classifyConfiguredHead(head, canonical, structured);
    if (configured !== null) return configured;
    // For built-in heads, fall back to the runner-gate / regex.
    // For non-built-in heads, structured-only — regex against
    // arbitrary text is unsafe.
    if (isBuiltIn) return familyFallback();
    return null;
  }
  return familyFallback();
}

// Codex r3 on PR #244: cut the canonical command at the first
// eval-shape flag so the fallback family regex never sees the
// argument text. `-c`, `--call`, `-e`, `--eval`, `-x`, `--exec`,
// `--run-script` cover npm-family / shell / interpreter eval forms.
//
// Codex r5 + claude r5 [contract-break] on PR #244: also cut on the
// attached-value form (`--call=value`, `-c=value`). npm/npx option
// parsing accepts both `--call value` and `--call=value`; missing the
// `=` form let `npx --call="echo playwright"` still classify as
// hard3 via the string-literal keyword. Match `token === flag` OR
// `token.toLowerCase().startsWith(flag + '=')`.
//
// Codex r6 [contract-break] on PR #244: also handle shell-quoted
// attached flags. `npx "--call=echo playwright"` tokenizes as
// `["npx", "\"--call=echo", "playwright\""]` after whitespace split;
// the actual argv (after shell strips quotes) is the same attached
// form. Same class covers the quoted standalone flag form
// (`npx "--call" "echo playwright"` → token `"--call"`). Strip BOTH
// leading and trailing shell quote characters (`"`, `'`, backtick)
// from each token before the eval-flag comparison so the cut catches
// all single-token quoting patterns: `"--call=v`, `--call="`,
// `"--call"`, `'--call'`.
//
// Codex r7 [contract-break] on PR #244: also strip ANSI-C / locale
// quote prefixes — bash/zsh `$'...'` (ANSI-C) and `$"..."` (locale
// translation) evaluate to the unquoted argv at execution time, so
// `npx $'--call=echo playwright'` is the same attached `--call=...`
// eval flag at argv level.
//
// Claude r7 [contract-break] on PR #244 (same surface, different
// quoting form): backslash-escaped quotes (`\"`, `\'`) common in
// JSON-encoded state.json entries also survived the r6 strip.
// `npx \"--call=echo playwright\"` token `\"--call=echo` was never
// trimmed.
//
// Unified strip: leading and trailing character class covers every
// shell-quote glyph that can wrap a flag token at the literal-text
// level: backslash, `$`, `"`, `'`, backtick. Each is independent of
// the others; the char class lets any combination peel off
// (`\"--call=...` → `\"`, `$'--call=...` → `$'`, `\'--call=...` →
// `\'`). A bare flag with no quoting is untouched.
function stripAtEvalFlag(canonical) {
  const tokens = String(canonical || '').split(/\s+/);
  const evalFlags = ['-c', '--call', '-e', '--eval', '-x', '--exec', '--run-script'];
  const cutAt = tokens.findIndex((t) => {
    const low = t.toLowerCase()
      .replace(/^[\\$"'`]+/, '')
      .replace(/[\\"'`]+$/, '');
    for (const flag of evalFlags) {
      if (low === flag) return true;
      if (low.startsWith(flag + '=')) return true;
    }
    return false;
  });
  if (cutAt <= 0) return canonical;
  return tokens.slice(0, cutAt).join(' ');
}

/**
 * Loose classifier — used by `mpl-gate-recorder` on real Bash
 * PostToolUse events. Matches family regexes against the full command
 * regardless of head. Recovers the pre-refactor behavior of the
 * recorder: a `docker compose run app npm test` invocation records as
 * hard2_coverage; a `bash -lc "npx playwright test"` records as
 * hard3_resilience. Commands that mention no family keyword at all
 * (e.g. `git commit`) still classify as null — the recorder didn't
 * record those either, so no regression.
 *
 * The strict head-denylist intentionally does NOT apply here because
 * an operator running a real test inside a wrapper is legitimate
 * coverage evidence; the strict denylist exists only to stop manual
 * `state.json` patches from masquerading as evidence.
 *
 * Codex r3 on PR #231 [data-integrity]: even on the recorder path
 * the shell never executed the redirect-target / comment text, so
 * `npm test > playwright` and `npm test # e2e` should classify as
 * hard2 (or null), NOT hard3. Strip everything from the first
 * unquoted redirect operator / `#` comment before matching, so the
 * family regex only sees the part the shell actually executed.
 */
function stripNonExecutedSuffix(command) {
  // Cut at the first occurrence of any token whose suffix is either
  // NOT executed (redirect target, comment) or is a SEPARATE command
  // (control operator / pipeline). The recorder's exit code applies
  // to the overall shell pipeline, not to the gate command alone, so
  // classifying the WHOLE composite as one family lets a downstream
  // segment's keyword forge gate evidence (codex r4 on PR #231).
  //
  // Cutting at the first control operator means we only classify the
  // leading simple command, which is what the recorder actually
  // intends to gate.
  //
  // The recorder operates on commands the shell already accepted and
  // ran, so we don't need full parse fidelity — only to stop the
  // family regex from matching keywords past these boundaries.
  // Quoting is rare in legitimate gate commands; over-truncating a
  // quoted argument falls in the safe direction (classifier returns
  // null → no gate evidence claimed).
  let cut = command.length;
  // Redirect targets / shell comments — not executed.
  // Control operators — separate command boundaries.
  for (const op of [
    '#', '>>', '>', '<<', '<', '2>', '&>', '|&',
    ';', '\n', '\r', '&&', '||', '|', '&',
  ]) {
    const idx = command.indexOf(op);
    if (idx !== -1 && idx < cut) cut = idx;
  }
  return command.slice(0, cut);
}

export function classifyRecordedCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const trimmed = stripNonExecutedSuffix(command);
  if (!trimmed.trim()) return null;
  return matchFamilyRegex(trimmed);
}

function matchFamilyRegex(command) {
  const c = command.trim().toLowerCase();
  if (HARD3_PATTERNS.some((re) => re.test(c))) return 'hard3_resilience';
  if (HARD2_PATTERNS.some((re) => re.test(c))) return 'hard2_coverage';
  if (HARD1_PATTERNS.some((re) => re.test(c))) return 'hard1_baseline';
  return null;
}

/**
 * Return `true` when `command` is in the family expected by `gateKey`.
 * Unclassified commands (classifier returns null) are NOT accepted —
 * Exp22 R13 specifically caught `git commit` masquerading as coverage
 * evidence. Manual writers MUST use a recognized command family or
 * record evidence through the recorder hook itself.
 */
export function commandMatchesGate(gateKey, command, { cwd } = {}) {
  const family = classifyGateCommand(command, { cwd });
  return family !== null && family === gateKey;
}
