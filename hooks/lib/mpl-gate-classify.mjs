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

// #240 A4: read .mpl/config.json `gate_classify.allowed_heads` and
// union it with the built-in set. Returns a Set of lowercase string
// heads. Non-string / non-array config values are ignored.
export function allowedGateHeads(cwd) {
  const merged = new Set(STRICT_GATE_HEAD_ALLOWLIST);
  if (!cwd) return merged;
  try {
    // Lazy import to avoid a circular dependency at module load time.
    // mpl-config.mjs is small and pure, so the cost is fine.
    const { loadConfigSync } = readConfigShim(cwd);
    const cfg = loadConfigSync(cwd);
    const extra = cfg?.gate_classify?.allowed_heads;
    if (Array.isArray(extra)) {
      for (const v of extra) {
        if (typeof v === 'string' && v.trim()) {
          merged.add(v.trim().toLowerCase());
        }
      }
    }
  } catch { /* fall back to built-in set on any read error */ }
  return merged;
}

// Lazy-loaded shim for the config reader. Avoids a top-level
// circular dependency between mpl-gate-classify.mjs and mpl-config.mjs.
let _loadConfigSync = null;
function readConfigShim() {
  if (_loadConfigSync) return { loadConfigSync: _loadConfigSync };
  // Use a sync import path via require-like read since loadConfig in
  // mpl-config.mjs is already synchronous.
  // We import statically at top of file by adding the import; the lazy
  // wrapper just preserves the previous external API.
  _loadConfigSync = loadConfig;
  return { loadConfigSync: _loadConfigSync };
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
  // #240 A4: union built-in allowlist with config extension when cwd is known.
  const allowed = cwd ? allowedGateHeads(cwd) : STRICT_GATE_HEAD_ALLOWLIST;
  if (!allowed.has(head)) return null;
  return matchFamilyRegex(canonical);
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
