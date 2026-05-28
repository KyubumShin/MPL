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
const STRICT_GATE_HEAD_ALLOWLIST = new Set([
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
]);

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
 */
export function classifyGateCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  // #220: composite / pipe / subshell forms must fail closed at the
  // strict level. Empirically `npm test; git commit -m e2e` had its
  // head extracted as `npm` (in the allowlist), then the family
  // regex matched `e2e` from the downstream commit message and
  // classified as hard3 — a real masquerade. Manual gate evidence
  // is a single command; recorder events accept composites via the
  // loose path.
  //
  // Reject any of: `;` (statement separator), `&&` / `||` (boolean
  // chains), backticks / `$(` (command substitution), `|` (pipe).
  // Each is a shell construct that lets a second command's text reach
  // the family regex through the first command's wrapper.
  if (/;|&&|\|\||`|\$\(|\|/.test(command)) return null;
  const head = extractCommandHead(command);
  if (!head) return null;
  if (NON_GATE_HEAD_COMMANDS.has(head)) return null;
  // Codex r7: even with a non-denied head, the head MUST be in the
  // explicit allowlist. `node`, `python`, `ruby`, `perl`, etc. are NOT
  // accepted manual gate evidence because their `-e`/`-c` forms can
  // contain arbitrary text that the family regex would erroneously
  // match.
  if (!STRICT_GATE_HEAD_ALLOWLIST.has(head)) return null;
  return matchFamilyRegex(command);
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
 */
export function classifyRecordedCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  return matchFamilyRegex(command);
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
export function commandMatchesGate(gateKey, command) {
  const family = classifyGateCommand(command);
  return family !== null && family === gateKey;
}
