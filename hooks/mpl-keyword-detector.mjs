#!/usr/bin/env node
/**
 * MPL Keyword Detector — thin wrapper (Move #12).
 *
 * Delegates the UserPromptSubmit keyword decision (research / activate /
 * already-active / locked / no-op) to
 * `lib/observability/signals.mjs::handleKeywordDetector`. The handler is
 * pure (it returns a decision envelope); the wrapper drives the side
 * effects the legacy hook owned:
 *
 *   1. Telemetry: `maybeIncrementInterventionCount(cwd)` — G6 (#114)
 *   2. State init: `initState(cwd, featureName, 'auto')` when activating
 *   3. Prior-state hint: read previous `.mpl/state.json` BEFORE init and
 *      append a recovery hint to the activation `additionalContext`
 *
 * Legacy verbatim impl preserved in `mpl-keyword-detector.legacy.mjs`.
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { initState, isMplActive, readState, writeState } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);
const { readStdin } = await import(pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href);
const { handleKeywordDetector } = await import(
  pathToFileURL(join(__dirname, 'lib', 'observability', 'signals.mjs')).href
);

function ok() { console.log(JSON.stringify({ continue: true, suppressOutput: true })); }

function maybeIncrementInterventionCount(cwd) {
  try {
    const state = readState(cwd);
    if (!state) return;
    if (state.current_phase === 'completed' || state.current_phase === 'cancelled') return;
    if (state.session_status === 'cancelled') return;
    if (state.run_mode !== 'auto') return;
    const before = typeof state.user_intervention_count === 'number' ? state.user_intervention_count : 0;
    writeState(cwd, { user_intervention_count: before + 1 });
  } catch { /* non-fatal */ }
}

function priorStateHint(cwd) {
  try {
    const prev = join(cwd, '.mpl', 'state.json');
    if (!existsSync(prev)) return '';
    const s = JSON.parse(readFileSync(prev, 'utf-8'));
    const paused = s.session_status === 'cancelled'
      || s.session_status === 'paused_budget'
      || s.session_status === 'paused_checkpoint'
      || s.current_phase === 'cancelled';
    if (paused && s.pipeline_id) {
      const what = s.session_status || s.current_phase || 'unknown';
      return `\n\n⚠️ Previous pipeline "${s.pipeline_id}" was "${what}". Archived to .mpl/archive/${s.pipeline_id}/.\n   If you meant to recover it, cancel this run and type \`/mpl:mpl-resume\` instead.`;
    }
  } catch { /* non-fatal */ }
  return '';
}

async function main() {
  try {
    const input = await readStdin();
    if (!input.trim()) return ok();
    let data = {};
    try { data = JSON.parse(input); } catch { /* */ }
    const cwd = data.cwd || data.directory || process.cwd();

    // Telemetry: count every non-task-notification prompt BEFORE branching.
    // The handler also returns early on task-notification XML; replicate that
    // gate here so telemetry is symmetric with the legacy contract.
    const promptPreview = data.prompt || data.message?.content || '';
    if (!/^<task-notification(?:\s|>)/i.test(String(promptPreview).trimStart())) {
      maybeIncrementInterventionCount(cwd);
    }

    const decision = handleKeywordDetector({
      event: 'UserPromptSubmit',
      cwd,
      state: readState(cwd),
      raw: data,
    });

    if (!decision || decision.action !== 'signal') return ok();

    // Activation path: init state + append the prior-state hint.
    let additionalContext = decision.additionalContext || '';
    if (decision.stateMutations && decision.stateMutations.kind === 'keyword.init') {
      const hint = priorStateHint(cwd);
      try { initState(cwd, decision.stateMutations.feature_name, decision.stateMutations.run_mode); }
      catch { /* fail-soft init */ }
      if (hint) {
        // Insert hint after the "State initialized ..." sentence (matches legacy format).
        additionalContext = additionalContext.replace(
          /(State initialized at \.mpl\/state\.json \(run_mode: "auto"\)\.)/,
          `$1${hint}`,
        );
      }
    }

    console.log(JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext,
      },
    }));
  } catch {
    ok();
  }
}

main();

export {
  sanitizePromptForKeyword as sanitize,
  isTaskNotificationPrompt,
  extractKeywordFeatureName as extractFeatureName,
} from './lib/observability/signals.mjs';

/**
 * extractPrompt — preserved for test compatibility (legacy hook exported it).
 * Returns the raw prompt text from a hook stdin payload (JSON string).
 */
export function extractPrompt(input) {
  try {
    const data = typeof input === 'string' ? JSON.parse(input) : input;
    if (data.prompt) return data.prompt;
    if (data.message?.content) return data.message.content;
    if (Array.isArray(data.parts)) {
      return data.parts.filter(p => p.type === 'text').map(p => p.text).join(' ');
    }
    return '';
  } catch { return ''; }
}
