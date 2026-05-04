/**
 * Bash command category classifier + timeout policy (G1 / #107).
 *
 * Maps verification-shaped Bash commands to category bounds. Used by
 * `mpl-bash-timeout.mjs` PreToolUse hook to enforce sensible timeout windows
 * (Claude Code default 2 min is fine for short utilities but kills longer
 * verification — vitest, playwright — prematurely; conversely commands without
 * any timeout cap can let infinite loops accumulate fix-loop wall time, the
 * exp15 phase-10 5h shape from v3.10 §6.6 G1).
 *
 * Pure functions: easily testable in isolation. Hook is a thin wrapper.
 */

/**
 * Category catalog. Commands matching `pattern` get the bounds.
 * - `minMs`: sanity floor — typo / accidentally low timeout is rejected.
 * - `maxMs`: ceiling — single-invocation budget. Strict-mode block when exceeded.
 * - `recommendedMs`: injected as the suggested value when the orchestrator omits timeout.
 *
 * Order matters — first match wins. Place narrower patterns first.
 */
export const CATEGORIES = [
  {
    name: 'playwright',
    // playwright test / npx playwright test / playwright {install,debug}
    // (`pw` alias intentionally omitted — non-standard, collides with `pwgen` etc.)
    pattern: /\b(?:npx\s+)?playwright\s+(?:install|test|debug)\b/,
    minMs: 60_000,
    maxMs: 600_000,
    recommendedMs: 600_000,
  },
  {
    name: 'vitest-jest',
    // vitest / jest / npm test / pnpm test / yarn test (the latter typically wraps vitest|jest).
    // Note: bare `vitest` (no args) defaults to watch mode in dev — keeping it in the
    // pattern is intentional. Watch hangs are precisely the 5h fix-loop wall G1 guards
    // against; if phase-runner forgets `run`, classifier still catches it.
    pattern: /\bvitest\b|\bjest\b|\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b/,
    minMs: 60_000,
    maxMs: 300_000,
    recommendedMs: 300_000,
  },
  {
    name: 'build',
    // vite build, cargo build, npm run build, go build, gradle compile/build, maven compile/verify/package.
    // (tsc is handled in classifyCommand to disambiguate --noEmit anywhere in the command.)
    pattern: /\bvite\s+build\b|\bcargo\s+build\b|\b(?:npm|pnpm|yarn)\s+(?:run\s+)?build\b|\bgo\s+build\b|\.\/gradlew\s+(?:compile\w*|build|assemble\w*)\b|\bmvn\s+(?:compile|verify|package|install)\b/,
    minMs: 30_000,
    maxMs: 180_000,
    recommendedMs: 180_000,
  },
  {
    name: 'typecheck-lint',
    // tsc --noEmit, eslint, biome, ruff, flake8, pyright, mypy, py_compile, cargo check,
    // npm/pnpm/yarn run {typecheck,lint,check}.
    pattern: /\beslint\b|\bbiome\s+check\b|\bruff\b|\bflake8\b|\bpyright\b|\bmypy\b|\bpython\s+-m\s+py_compile\b|\bcargo\s+check\b|\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:typecheck|lint|check)\b/,
    minMs: 10_000,
    maxMs: 120_000,
    recommendedMs: 120_000,
  },
];

/**
 * Classify a command into a category. Returns null when no category matches —
 * such commands get no timeout enforcement (orchestrator decides freely).
 *
 * @param {string} command
 * @returns {(typeof CATEGORIES)[number] | null}
 */
export function classifyCommand(command) {
  if (!command || typeof command !== 'string') return null;
  // tsc special case: `--noEmit` may appear after `-p tsconfig.json`, `--project`, etc.
  // Single-pass lookahead (the prior approach) only inspected the token immediately
  // after `tsc`, misclassifying `tsc -p tsconfig.json --noEmit` as build.
  if (/\btsc\b/.test(command)) {
    const name = /--noEmit\b/.test(command) ? 'typecheck-lint' : 'build';
    return CATEGORIES.find((c) => c.name === name);
  }
  for (const c of CATEGORIES) {
    if (c.pattern.test(command)) return c;
  }
  return null;
}

/**
 * Decide whether a command + timeout combination is acceptable.
 *
 * @param {string} command
 * @param {number | undefined | null} timeoutMs - tool_input.timeout in milliseconds
 * @param {{ strict?: boolean }} [opts]
 * @returns {{
 *   action: 'silent' | 'warn' | 'block',
 *   category: string | null,
 *   reason: string,
 *   recommendedMs: number | null,
 * }}
 */
export function decideTimeout(command, timeoutMs, opts = {}) {
  const strict = opts.strict === true;
  const cat = classifyCommand(command);
  if (!cat) return { action: 'silent', category: null, reason: '', recommendedMs: null };

  const present = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0;

  // Case 1: missing timeout for a verification-shaped command.
  if (!present) {
    return {
      action: strict ? 'block' : 'warn',
      category: cat.name,
      reason: `[MPL G1] ${cat.name} command needs an explicit timeout. Add tool_input.timeout=${cat.recommendedMs} (≥${cat.minMs}, ≤${cat.maxMs} ms). exp15 §6.6 G1: untimed verification accumulates 5h fix-loop walls.`,
      recommendedMs: cat.recommendedMs,
    };
  }

  // Case 2: timeout below the sanity floor (likely typo, e.g. 200 instead of 200000).
  if (timeoutMs < cat.minMs) {
    return {
      action: strict ? 'block' : 'warn',
      category: cat.name,
      reason: `[MPL G1] ${cat.name} timeout=${timeoutMs}ms is below the sanity floor (${cat.minMs}ms). Likely a typo — bump to ${cat.recommendedMs}ms.`,
      recommendedMs: cat.recommendedMs,
    };
  }

  // Case 3: timeout above the ceiling — clamp request.
  if (timeoutMs > cat.maxMs) {
    return {
      action: strict ? 'block' : 'warn',
      category: cat.name,
      reason: `[MPL G1] ${cat.name} timeout=${timeoutMs}ms exceeds the per-call ceiling (${cat.maxMs}ms). Reduce or split the run; persistent over-budget points to fix-loop wall accumulation.`,
      recommendedMs: cat.maxMs,
    };
  }

  // Case 4: in range.
  return { action: 'silent', category: cat.name, reason: '', recommendedMs: null };
}
