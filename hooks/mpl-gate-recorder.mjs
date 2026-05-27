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
 *    `state.test_agent_dispatched[phase_id] = {timestamp, prompt_len,
 *    response_len, valid_json, verdict, command_exit_codes, ...}` so AD-0004's
 *    empirical gap becomes observable and AD-0007 can require a real PASS.
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
const { parseTestAgentEvidence, isPassingTestAgentEvidence } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-test-agent-evidence.mjs')).href
);
const {
  appendSubagentReturnAnomaly,
  detectSubagentReturnAnomaly,
  formatSubagentAnomalyMessage,
} = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-subagent-anomaly.mjs')).href
);
const { buildBlockedHookPatch } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-blocked-hook.mjs')).href
);
const { classifyRecordedCommand } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-gate-classify.mjs')).href
);

function ok(systemMessage = null) {
  if (systemMessage) {
    console.log(JSON.stringify({ continue: true, systemMessage }));
    return;
  }
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
 * The actual pattern lists live in hooks/lib/mpl-gate-classify.mjs so the
 * state-invariant (I12) can apply the SAME family check on proposed
 * manual writes to state.gate_results.
 *
 * Users can override by putting a `.mpl/verify.sh` that emits exit codes tagged
 * via the `MPL_GATE=<name>` environment variable; this heuristic is the fallback
 * when no verify.sh is in use.
 */
// Re-exported as classifyRecordedCommand from hooks/lib/mpl-gate-classify.mjs.
// Recorder path uses the LOOSE classifier (no head denylist) so legitimate
// execution wrappers (`docker compose run app npm test`, `kubectl exec ...
// npm test`, `bash -lc "playwright test"`) still record coverage evidence
// — codex r6 on PR #219 regression. The strict denylist applies only to
// manual `state.gate_results` writes via the I12 invariant.
const classifyGate = (command) => classifyRecordedCommand(command);

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
  const toolResponse = data.tool_response ?? data.toolResponse ?? {};

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

    // Stage A Phase 1.6c-i (PR #186 review): route gate evidence based on
    // current_phase. When the orchestrator is at `release-gate`, scoped
    // Hard 1/2/3 evidence MUST land in `state.release.gate_results` —
    // writing to top-level `state.gate_results` would (a) pollute the
    // whole-pipeline subtree reserved for the final phase3-gate (RFC §5.5
    // isolation), and (b) leave `state.release.gate_results` empty so the
    // release-gate handler reads MISSING forever.
    //
    // This is the resume doc §7 Q2 option (c) — "recorder routes to
    // release-scoped only when current_phase == 'release-gate'". The
    // existing top-level path is preserved unchanged for every other
    // phase (phase3-gate runs the whole-pipeline gate).
    const isReleaseGatePhase = state.current_phase === 'release-gate';
    const priorResults = isReleaseGatePhase
      ? (state.release?.gate_results || {})
      : (state.gate_results || {});
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

    function buildPatch(updatedGate) {
      if (isReleaseGatePhase) {
        // Merge into state.release.gate_results, preserving sibling
        // release fields (current_cut_id, completed_cut_ids,
        // fix_loop_count, etc.) via deepMerge.
        return { release: { gate_results: { ...priorResults, [gateName]: updatedGate } } };
      }
      return { gate_results: { ...priorResults, [gateName]: updatedGate } };
    }

    // First failure wins within a phase (so a later success cannot mask a
    // prior failure). A later fix-loop that writes `exit_code: 0` resets the
    // record — which is intended because the fix did actually pass.
    if (priorEntry && priorEntry.exit_code !== 0 && recordedExit === 0) {
      // Keep the latest on success after prior failure (fix-loop succeeded)
      writeState(cwd, buildPatch(newEntry));
    } else if (!priorEntry || priorEntry.exit_code === 0 || recordedExit !== 0) {
      writeState(cwd, buildPatch(newEntry));
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
    const phaseIdFromPrompt = extractPhaseId(toolInput.prompt || toolInput.description || '');

    // Codex r8/r11 on PR #218: background Task dispatches can deliver a
    // handle stub on the first PostToolUse event, not the final assistant
    // text. The anomaly detector would otherwise classify that blank as
    // empty_response and freeze the pipeline before the real completion
    // is joined.
    //
    // r11 [data-integrity]: skipping on run_in_background ALONE was too
    // coarse — if the same hook later sees the actual completion through
    // PostToolUse with substantive content, we still want to record
    // test-agent evidence. So skip ONLY when run_in_background is true
    // AND the response looks like a handle stub (object-shaped, no
    // usable text payload). Real completion content lands in the normal
    // anomaly + evidence pipeline.
    const bgFlag = toolInput?.run_in_background === true
      || toolInput?.runInBackground === true;
    const isHandleStubShape = (
      bgFlag
      && toolResponse !== null
      && typeof toolResponse === 'object'
      && !Array.isArray(toolResponse)
      && (toolResponse.handle !== undefined
          || toolResponse.taskId !== undefined
          || toolResponse.task_id !== undefined
          || toolResponse.id !== undefined)
      && typeof toolResponse.text !== 'string'
      && typeof toolResponse.response !== 'string'
      && typeof toolResponse.output !== 'string'
      && typeof toolResponse.content !== 'string'
      && !Array.isArray(toolResponse.content)
    );
    const isBackgroundDispatch = isHandleStubShape;
    const anomaly = isBackgroundDispatch ? null : detectSubagentReturnAnomaly({
      data,
      agentType,
      phaseId: phaseIdFromPrompt,
    });
    if (anomaly) appendSubagentReturnAnomaly(cwd, anomaly);

    // Branch 2: test-agent dispatch record (AD-0004 empirical gap).
    // Skip background dispatches — same reasoning as the anomaly branch.
    if (/mpl-test-agent$/.test(agentType) && !isBackgroundDispatch) {
      const phaseId = phaseIdFromPrompt;
      if (phaseId) {
        const dispatched = state.test_agent_dispatched || {};
        const evidence = parseTestAgentEvidence({
          phaseId,
          prompt: toolInput.prompt || toolInput.description || '',
          response: toolResponse,
          anomaly,
        });
        dispatched[phaseId] = evidence;
        patch.test_agent_dispatched = dispatched;
        if (
          state.session_status === 'blocked_hook' &&
          state.blocked_by_hook === 'mpl-require-test-agent' &&
          state.blocked_phase === phaseId &&
          isPassingTestAgentEvidence(evidence)
        ) {
          patch.session_status = null;
          patch.blocked_by_hook = null;
          patch.blocked_phase = null;
          patch.block_reason = null;
          patch.resume_instruction = null;
          patch.blocked_at = null;
        }
      }
    }

    // Branch 3: phase-runner completion → sync completed_todos with disk
    // truth. Codex r3+r4 on PR #218: when the phase-runner returned
    // anomalous output, the hook MUST NOT advance completed_todos AND
    // MUST install a structural block (session_status='blocked_hook')
    // so the orchestrator pauses regardless of PLAN.md / TODO state.
    // The anomaly is also persisted in state.subagent_return_anomalies.
    if (/mpl-phase-runner$/.test(agentType) && !isBackgroundDispatch) {
      if (anomaly) {
        // Only install the block when no stronger session state is
        // already in effect. Codex r5/r10 on PR #218: do not clobber
        // - blocked_hook (operator may have a more specific block)
        // - paused_budget / paused_checkpoint (budget guard)
        // - verification_hang (verification gate)
        // - cancelled (user-cancelled run)
        // The anomaly is still recorded in state.subagent_return_anomalies
        // for visibility, but the session status takes precedence.
        const installableFromStatus = state.session_status === null
          || state.session_status === undefined
          || state.session_status === 'active';
        if (installableFromStatus) {
          Object.assign(patch, buildBlockedHookPatch({
            hookId: 'mpl-gate-recorder',
            phaseId: anomaly.phase_id || state.current_phase || 'unknown',
            artifact: `state.subagent_return_anomalies[${anomaly.type}]`,
            code: `phase_runner_${anomaly.type}`,
            reason: `mpl-phase-runner returned ${anomaly.type} (tools=${anomaly.tools_used ?? '?'}, tokens=${anomaly.output_tokens ?? '?'}). Recorded in state.subagent_return_anomalies; cannot advance until verified.`,
            resumeInstruction: 'Verify on-disk artifacts for the phase, then either re-dispatch mpl-phase-runner or correct state by hand and clear the block.',
            retryContext: {
              agent_type: 'mpl-phase-runner',
              anomaly_type: anomaly.type,
              phase_id: anomaly.phase_id,
            },
          }));
        }
      } else {
        // Codex r6/r7 on PR #218: a clean re-dispatch must self-clear
        // our own phase_runner_* block, otherwise transient anomalies
        // leave the run permanently paused. Only clear when ALL of:
        //   - the block is owned by mpl-gate-recorder
        //   - block_code starts with phase_runner_
        //   - the clean completion is for the SAME phase that was
        //     blocked (match state.blocked_phase or
        //     retry_context.phase_id). A different phase's clean
        //     completion must NOT clear another phase's anomaly block.
        if (state.session_status === 'blocked_hook'
            && state.blocked_by_hook === 'mpl-gate-recorder'
            && typeof state.block_code === 'string'
            && state.block_code.startsWith('phase_runner_')) {
          const blockedPhaseId = state.blocked_phase
            || (state.retry_context && state.retry_context.phase_id)
            || null;
          if (phaseIdFromPrompt && blockedPhaseId && phaseIdFromPrompt === blockedPhaseId) {
            patch.session_status = null;
            patch.blocked_by_hook = null;
            patch.blocked_phase = null;
            patch.blocked_artifact = null;
            patch.block_code = null;
            patch.block_reason = null;
            patch.resume_instruction = null;
            patch.retry_context = null;
            patch.blocked_at = null;
          }
        }
        const diskCount = countCompletedPhases(cwd);
        const prior = state.sprint_status || {};
        if (prior.completed_todos !== diskCount) {
          patch.sprint_status = { ...prior, completed_todos: diskCount };
        }
      }
    }

    if (Object.keys(patch).length > 0) {
      writeState(cwd, patch);
    }
    ok(formatSubagentAnomalyMessage(anomaly));
    process.exit(0);
  }

  ok();
} catch {
  // Hook must never break the pipeline.
  ok();
}
