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
  const tokens = command.trim().split(/\s+/);
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (!t) { i++; continue; }
    // env assignment "VAR=value"
    if (/^[A-Z_][A-Z0-9_]*=/i.test(t)) { i++; continue; }
    const lower = t.toLowerCase();
    if (COMMAND_PREFIX_TOKENS.has(lower)) { i++; continue; }
    // Take basename: last `/`-separated component. Strip leading `./`
    // first so `./scripts/run.sh` reduces to `run.sh`.
    const stripped = lower.replace(/^\.\//, '');
    const lastSlash = stripped.lastIndexOf('/');
    return lastSlash === -1 ? stripped : stripped.slice(lastSlash + 1);
  }
  return '';
}

export function classifyGateCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const head = extractCommandHead(command);
  if (NON_GATE_HEAD_COMMANDS.has(head)) return null;
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
