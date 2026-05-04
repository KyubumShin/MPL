#!/usr/bin/env node
/**
 * MPL Quality Gate Hook (PostToolUse Task|Agent, P0-A redesign #103)
 *
 * Fires after the orchestrator dispatches `Task(subagent_type='mpl-adversarial-reviewer')`
 * and the agent has written `.mpl/signals/quality-score.json`. Reads the
 * score, decides pass / retry / escalate, mutates state (retry counter +
 * history), and surfaces the next action to the orchestrator.
 *
 * Triggers ONLY on Task/Agent invocations whose subagent_type names the
 * adversarial reviewer — other Task dispatches (test agents, codebase
 * analyzer, etc.) are silent passthrough.
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync, readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { isMplActive, readState, writeState } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);
const { loadConfig } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-config.mjs')).href
);
const {
  parseScore,
  decideAction,
  composeHistoryEntry,
  DEFAULT_QUALITY_THRESHOLD,
  DEFAULT_MAX_ADVERSARIAL_RETRIES,
} = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-quality-gate.mjs')).href
);

const SCORE_PATH = '.mpl/signals/quality-score.json';
const ADVERSARIAL_AGENT = 'mpl-adversarial-reviewer';

function silent() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

function isAdversarialDispatch(toolName, toolInput) {
  if (!['Task', 'Agent', 'task', 'agent'].includes(toolName)) return false;
  const sub = toolInput?.subagent_type || toolInput?.subagentType;
  return sub === ADVERSARIAL_AGENT;
}

async function main() {
  const input = await readStdin();
  let data;
  try { data = JSON.parse(input); } catch { return silent(); }

  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) return silent();

  const toolName = data.tool_name || data.toolName || '';
  const toolInput = data.tool_input || data.toolInput || {};

  if (!isAdversarialDispatch(toolName, toolInput)) return silent();

  const scoreFile = join(cwd, SCORE_PATH);
  if (!existsSync(scoreFile)) {
    // Reviewer ran but did not write the score artifact — treat as missing
    // signal. Silent so the orchestrator can decide; the quality_score_history
    // will simply not gain an entry this round.
    return silent();
  }

  let raw;
  try { raw = readFileSync(scoreFile, 'utf-8'); } catch { return silent(); }

  const parsed = parseScore(raw);
  if (!parsed) {
    console.log(JSON.stringify({
      continue: true,
      systemMessage: `[MPL P0-A] quality-score.json is malformed — expected {phase, score, verdict, issues[], timestamp}. Reviewer must rewrite the file.`,
    }));
    return;
  }

  const state = readState(cwd) || {};
  const config = loadConfig(cwd);
  const adv = (config && typeof config.adversarial === 'object') ? config.adversarial : {};
  const threshold = typeof adv.threshold === 'number' ? adv.threshold : DEFAULT_QUALITY_THRESHOLD;
  const maxRetries = typeof adv.max_retries === 'number' ? adv.max_retries : DEFAULT_MAX_ADVERSARIAL_RETRIES;
  const retryCount = typeof state.adversarial_retry_count === 'number' ? state.adversarial_retry_count : 0;

  const decision = decideAction(parsed, { retryCount, threshold, maxRetries });
  const entry = composeHistoryEntry(parsed, decision);

  // Persist history regardless of action. Retry counter advances on retry,
  // resets on pass, freezes (== maxRetries) on escalate so resume can see
  // the wall hit.
  const history = Array.isArray(state.quality_score_history) ? state.quality_score_history : [];
  let nextRetry;
  if (decision.action === 'pass') nextRetry = 0;
  else if (decision.action === 'retry') nextRetry = retryCount + 1;
  else nextRetry = retryCount; // escalate — preserve last value
  try {
    writeState(cwd, {
      adversarial_retry_count: nextRetry,
      quality_score_history: [...history, entry],
    });
  } catch {
    // Best-effort — never block the surfacing decision on disk.
  }

  if (decision.action === 'pass') {
    console.log(JSON.stringify({
      continue: true,
      systemMessage: decision.reason,
    }));
    return;
  }

  // retry or escalate — both surface the reason via systemMessage so the
  // orchestrator (commands/mpl-run-execute.md Step 4.3.8) can branch:
  // retry → re-dispatch phase-runner with reviewer feedback;
  // escalate → halt and ask the user.
  console.log(JSON.stringify({
    continue: true,
    systemMessage: decision.reason,
  }));
}

await main().catch(() => silent());
