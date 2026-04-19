#!/usr/bin/env node
/**
 * MPL Gate Recorder Hook (PostToolUse on Bash|Task|Agent)
 *
 * Writes machine evidence to `.mpl/state.json` so `mpl-run-finalize.md` can consume
 * structured truth instead of orchestrator self-report (AD-0006, #38/#39/AD-0004).
 *
 * Three responsibilities, selected by `data.tool_name`:
 *
 * 1. **Bash** — when the command matches a known gate pattern (pnpm lint/test/build,
 *    cargo test/clippy, OR an entry from `.mpl/verify.sh` output OR `state.verification_commands`),
 *    record `state.gate_results[gate_name] = {command, exit_code, stdout_tail, timestamp}`.
 *
 * 2. **Task|Agent** with `subagent_type == "mpl-test-agent"` — record
 *    `state.test_agent_dispatched[phase_id] = {timestamp, prompt_len, response_len}`
 *    so AD-0004's empirical gap becomes observable.
 *
 * 3. **Task|Agent** with `subagent_type == "mpl-phase-runner"` and a completed state-summary
 *    file on disk — increment `state.sprint_status.completed_todos` to match disk truth
 *    (fixes #35 drift where sprint_status stays 0/0 even after phases complete).
 *
 * Non-blocking: always returns `{continue: true}`. Swallows every error.
 *
 * Design anchors (AD-0006):
 *   - Framework-agnostic: gate name inference is heuristic, not hardcoded per stack.
 *   - SSOT: `state.json.gate_results` is the only recognised evidence source going forward.
 *   - Structural enforcement: orchestrator cannot bypass this hook by self-reporting —
 *     the hook fires regardless of prompt behaviour.
 */

import { dirname, join, basename } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync, readdirSync, readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { readState, writeState, isMplActive } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);

function ok() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

/**
 * Classify a bash command into a MPL gate name, or null if unrelated.
 *
 * Heuristic matching:
 *   hard1_baseline  — lint/typecheck/build commands
 *   hard2_coverage  — unit/integration test commands
 *   hard3_resilience — e2e/playwright/contract/a11y test commands
 *
 * Users can override by putting a `.mpl/verify.sh` that emits exit codes tagged
 * via the `MPL_GATE=<name>` environment variable; this heuristic is the fallback
 * when no verify.sh is in use.
 */
function classifyGate(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const c = command.trim().toLowerCase();

  const hard3Patterns = [
    /\bplaywright\b/,
    /\bcypress\b/,
    /\be2e\b/,
    /\bcontract\b/,
    /jest.*\be2e\b/,
    /wdio/,
  ];
  if (hard3Patterns.some((re) => re.test(c))) return 'hard3_resilience';

  const hard2Patterns = [
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
  if (hard2Patterns.some((re) => re.test(c))) return 'hard2_coverage';

  const hard1Patterns = [
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
  if (hard1Patterns.some((re) => re.test(c))) return 'hard1_baseline';

  return null;
}

function tailOf(text, n = 500) {
  const s = typeof text === 'string' ? text : JSON.stringify(text || '');
  return s.length <= n ? s : s.slice(-n);
}

/**
 * AD-0008: parse .mpl/mpl/e2e-scenarios.yaml to find which scenario id (if any)
 * this Bash command corresponds to. Matches by prefix on the scenario's
 * test_command — the scenario's command must be a prefix of the actual Bash
 * command (so "pnpm playwright test e2e/scenario-1.spec.ts" matches
 * "pnpm playwright test e2e/scenario-1.spec.ts --reporter=json").
 *
 * Returns { id: string } or null if no match. Uses naive YAML scanning to
 * avoid third-party deps.
 */
function matchE2eScenario(cwd, command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const path = join(cwd, '.mpl', 'mpl', 'e2e-scenarios.yaml');
  if (!existsSync(path)) return null;

  let text;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }

  const cmd = command.trim();
  let curId = null;
  let curTestCommand = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');

    const idMatch = line.match(/^\s*-\s+id:\s*["']?(E2E-[\w-]+)["']?/);
    if (idMatch) {
      // Commit previous entry match check happens as we scan; here we reset
      curId = idMatch[1];
      curTestCommand = null;
      continue;
    }
    if (!curId) continue;

    const tcMatch = line.match(/^\s+test_command:\s*["']?(.+?)["']?\s*$/);
    if (tcMatch) {
      curTestCommand = tcMatch[1].trim();
      // Prefix match: scenario's command must be a prefix of the actual command
      if (curTestCommand && cmd.startsWith(curTestCommand)) {
        return { id: curId, test_command: curTestCommand };
      }
    }
  }

  return null;
}

/**
 * Count phase directories on disk that have a state-summary.md — this is the
 * disk-truth count for `sprint_status.completed_todos` (closes #35 drift).
 */
function countCompletedPhases(cwd) {
  const phasesDir = join(cwd, '.mpl', 'mpl', 'phases');
  if (!existsSync(phasesDir)) return 0;
  try {
    const entries = readdirSync(phasesDir, { withFileTypes: true });
    let count = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const summary = join(phasesDir, entry.name, 'state-summary.md');
      if (existsSync(summary)) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * Extract phase id from the phase-runner's prompt (best-effort).
 * Looks for "phase-N" or "Phase N" tokens.
 */
function extractPhaseId(promptText) {
  if (typeof promptText !== 'string') return null;
  const match = promptText.match(/\bphase[-\s]?(\d+)\b/i);
  return match ? `phase-${match[1]}` : null;
}

try {
  const raw = await readStdin();
  if (!raw.trim()) {
    ok();
    process.exit(0);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    ok();
    process.exit(0);
  }

  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) {
    ok();
    process.exit(0);
  }

  const toolName = String(data.tool_name || data.toolName || '');
  const toolInput = data.tool_input || data.toolInput || {};
  const toolResponse = data.tool_response || data.toolResponse || {};

  // Tool response may be string or object — normalize
  const exitCode =
    typeof toolResponse === 'object' && toolResponse !== null
      ? (toolResponse.exit_code ?? toolResponse.exitCode ?? toolResponse.returncode)
      : undefined;
  const stdout =
    typeof toolResponse === 'object' && toolResponse !== null
      ? (toolResponse.stdout ?? toolResponse.output ?? '')
      : String(toolResponse);

  // ---- Branch 1: Bash gate recording -------------------------------------
  if (toolName === 'Bash' || toolName === 'bash') {
    const command = toolInput.command || toolInput.cmd || '';

    const state = readState(cwd);
    if (!state) {
      ok();
      process.exit(0);
    }

    // AD-0008: E2E scenario match — orthogonal to gate classification. A
    // playwright command can simultaneously match a named scenario AND be
    // classified as hard3_resilience. Record both; finalize consumes e2e_results
    // per-scenario while gate_results stays at the aggregated gate level.
    const scenario = matchE2eScenario(cwd, command);
    if (scenario) {
      const recordedExit =
        typeof exitCode === 'number'
          ? exitCode
          : /error|failed|✖|exit code 1/i.test(stdout) ? 1 : 0;
      const priorE2e = state.e2e_results || {};
      const newE2eEntry = {
        command: command.slice(0, 500),
        test_command: scenario.test_command,
        exit_code: recordedExit,
        stdout_tail: tailOf(stdout, 500),
        timestamp: new Date().toISOString(),
      };
      const priorE2eEntry = priorE2e[scenario.id];
      // First failure wins within a run unless a later run fixes it
      if (
        !priorE2eEntry ||
        priorE2eEntry.exit_code === 0 ||
        recordedExit !== 0
      ) {
        writeState(cwd, {
          e2e_results: { ...priorE2e, [scenario.id]: newE2eEntry },
        });
      }
    }

    const gateName = classifyGate(command);
    if (!gateName) {
      ok();
      process.exit(0);
    }

    const priorResults = state.gate_results || {};
    const priorEntry = priorResults[gateName];
    // Convert legacy boolean fields (hard1_passed: true) into structured entry
    // by overwriting; no loss because legacy booleans are self-report and
    // AD-0006 explicitly drops them as evidence.

    const recordedExit =
      typeof exitCode === 'number'
        ? exitCode
        : /error|failed|✖|exit code 1/i.test(stdout) ? 1 : 0;

    const newEntry = {
      command: command.slice(0, 500),
      exit_code: recordedExit,
      stdout_tail: tailOf(stdout, 500),
      timestamp: new Date().toISOString(),
    };

    // First failure wins within a phase (so a later success cannot mask a
    // prior failure). A later fix-loop that writes `exit_code: 0` resets the
    // record — which is intended because the fix did actually pass.
    if (priorEntry && priorEntry.exit_code !== 0 && recordedExit === 0) {
      // Keep the latest on success after prior failure (fix-loop succeeded)
      writeState(cwd, { gate_results: { ...priorResults, [gateName]: newEntry } });
    } else if (!priorEntry || priorEntry.exit_code === 0 || recordedExit !== 0) {
      writeState(cwd, { gate_results: { ...priorResults, [gateName]: newEntry } });
    }
    ok();
    process.exit(0);
  }

  // ---- Branch 2 & 3: Task/Agent tracking ---------------------------------
  if (['Task', 'task', 'Agent', 'agent'].includes(toolName)) {
    const agentType = String(toolInput.subagent_type || toolInput.subagentType || '');
    const state = readState(cwd);
    if (!state) {
      ok();
      process.exit(0);
    }

    const patch = {};

    // Branch 2: test-agent dispatch record (AD-0004 empirical gap)
    if (/mpl-test-agent$/.test(agentType)) {
      const phaseId =
        extractPhaseId(toolInput.prompt || toolInput.description || '') || 'unknown';
      const respStr =
        typeof toolResponse === 'string' ? toolResponse : JSON.stringify(toolResponse);
      const dispatched = state.test_agent_dispatched || {};
      dispatched[phaseId] = {
        timestamp: new Date().toISOString(),
        prompt_len: (toolInput.prompt || '').length,
        response_len: respStr.length,
      };
      patch.test_agent_dispatched = dispatched;
    }

    // Branch 3: phase-runner completion → sync completed_todos with disk truth
    if (/mpl-phase-runner$/.test(agentType)) {
      const diskCount = countCompletedPhases(cwd);
      const prior = state.sprint_status || {};
      if (prior.completed_todos !== diskCount) {
        patch.sprint_status = { ...prior, completed_todos: diskCount };
      }
    }

    if (Object.keys(patch).length > 0) {
      writeState(cwd, patch);
    }
    ok();
    process.exit(0);
  }

  ok();
} catch {
  // Hook must never break the pipeline.
  ok();
}
