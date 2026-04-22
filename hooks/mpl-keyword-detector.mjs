#!/usr/bin/env node
/**
 * MPL Keyword Detector Hook (UserPromptSubmit)
 * Detects "mpl" keyword in user input and initializes MPL pipeline state.
 *
 * Based on: design doc section 9.2 hook 4 + OMC keyword-detector.mjs pattern
 *
 * When "mpl" is detected:
 * 1. Initialize .mpl/state.json with default state
 * 2. Return [MAGIC KEYWORD: MPL] message to trigger MPL skill
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync, readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import shared MPL state utility
const { initState, isMplActive } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);

// Import shared stdin reader
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);

/**
 * Extract prompt text from hook input JSON
 */
function extractPrompt(input) {
  try {
    const data = JSON.parse(input);
    if (data.prompt) return data.prompt;
    if (data.message?.content) return data.message.content;
    if (Array.isArray(data.parts)) {
      return data.parts
        .filter(p => p.type === 'text')
        .map(p => p.text)
        .join(' ');
    }
    return '';
  } catch {
    return '';
  }
}

/**
 * Sanitize text for keyword detection (strip code blocks, URLs, paths)
 */
function sanitize(text) {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, '')
    .replace(/https?:\/\/[^\s)>\]]+/g, '')
    .replace(/(?<=^|[\s"'`(])(?:\/)?(?:[\w.-]+\/)+[\w.-]+/gm, '');
}

/**
 * Extract feature name from user prompt
 */
function extractFeatureName(prompt) {
  // Try to extract a meaningful name from the prompt
  const cleaned = prompt.replace(/\bmpl\b/gi, '').trim();
  if (!cleaned) return 'unnamed';

  // Take first few meaningful words
  const words = cleaned
    .split(/\s+/)
    .filter(w => w.length > 2 && !/^(the|and|for|with|this|that|from|into)$/i.test(w))
    .slice(0, 4);

  return words.join('-').toLowerCase()
    .replace(/[^a-z0-9가-힣ぁ-ゔァ-ヴ\u4e00-\u9fff-]/g, '')
    .replace(/^[-]+|[-]+$/g, '') || 'task';
}

async function main() {
  try {
    const input = await readStdin();
    if (!input.trim()) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    let data = {};
    try { data = JSON.parse(input); } catch {}
    const cwd = data.cwd || data.directory || process.cwd();

    const prompt = extractPrompt(input);
    if (!prompt) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    // v0.14.1 #36: Non-initializing MPL slash commands must NOT reset state.json.
    // These commands read or transform existing state — they never start a new pipeline.
    // (Init command NOT in this list: `/mpl:mpl`)
    const SLASH_NO_INIT = /^\s*\/mpl:mpl-(resume|cancel|status|doctor|setup|version-bump|pivot|gap-analysis)\b/i;
    if (SLASH_NO_INIT.test(prompt)) {
      // Let the slash command skill manage state. Keep state.json untouched.
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    const cleanPrompt = sanitize(prompt).toLowerCase();

    // Detect "mpl" keyword (word boundary to avoid false positives)
    if (!/\bmpl\b/i.test(cleanPrompt)) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    // Detect standalone research invocation: "mpl research|investigate|survey"
    // Must check BEFORE isMplActive — standalone research doesn't need full pipeline
    const isResearchRun = /\bmpl[\s-]*(research|investigate|survey)\b/i.test(cleanPrompt);

    if (isResearchRun) {
      // Check for active pipeline — block standalone research during pipeline
      if (isMplActive(cwd)) {
        console.log(JSON.stringify({
          continue: true,
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: '[MPL] Pipeline research in progress. Use `/mpl:mpl-status` to check.'
          }
        }));
        return;
      }

      // BUG-4 fix: Check for research lock file (another standalone research running)
      const lockPath = join(cwd, '.mpl', 'research', '.lock');
      if (existsSync(lockPath)) {
        console.log(JSON.stringify({
          continue: true,
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: '[MPL] Another standalone research is in progress. Wait for it to complete or delete .mpl/research/.lock to force.'
          }
        }));
        return;
      }

      // Trigger standalone research skill (no full pipeline init)
      const researchTopic = prompt.replace(/\bmpl[\s-]*(research|investigate|survey)\b/gi, '').trim();
      console.log(JSON.stringify({
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: `[MAGIC KEYWORD: MPL-RESEARCH]

MPL Standalone Research activated.

You MUST invoke the skill using the Skill tool:

Skill: mpl-research

User request:
${prompt}

Research topic: ${researchTopic || 'as described in user request'}

IMPORTANT: Run the standalone research protocol. Results will be saved to .mpl/research/.`
        }
      }));
      return;
    }

    // Check if MPL is already active
    if (isMplActive(cwd)) {
      // MPL already running - don't re-initialize
      console.log(JSON.stringify({
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: '[MPL] Pipeline already active. Use current session or cancel first.'
        }
      }));
      return;
    }

    // v0.17 (#55): Triage / Quick Scope Scan removed. Phase 0 no longer
    // branches on pp_proximity — decomposer expresses scope via phase count.

    // v0.14.1 #36: Capture prior pipeline state BEFORE initState overwrites it.
    // If the previous run was cancelled or paused, surface the recovery path in the
    // announcement so the user notices that a resume option existed.
    let priorStateHint = '';
    try {
      const prevStatePath = join(cwd, '.mpl', 'state.json');
      if (existsSync(prevStatePath)) {
        const prev = JSON.parse(readFileSync(prevStatePath, 'utf-8'));
        const pausedLike = prev.session_status === 'cancelled'
          || prev.session_status === 'paused_budget'
          || prev.session_status === 'paused_checkpoint'
          || prev.current_phase === 'cancelled';
        if (pausedLike && prev.pipeline_id) {
          const what = prev.session_status || prev.current_phase || 'unknown';
          priorStateHint = `\n\n⚠️ Previous pipeline "${prev.pipeline_id}" was "${what}". Archived to .mpl/archive/${prev.pipeline_id}/.\n   If you meant to recover it, cancel this run and type \`/mpl:mpl-resume\` instead.`;
        }
      }
    } catch {
      // Non-fatal — recovery hint is best-effort
    }

    // Initialize MPL state — always single entry point
    const featureName = extractFeatureName(prompt);
    initState(cwd, featureName, 'auto');

    // v0.17 (#55): single-track Phase 0 — no proximity classification
    const message = `[MAGIC KEYWORD: MPL]

MPL Pipeline activated. State initialized at .mpl/state.json (run_mode: "auto").${priorStateHint}

You MUST invoke the skill using the Skill tool:

Skill: mpl

User request:
${prompt}

IMPORTANT: Load the MPL orchestration protocol via /mpl:mpl-run command, then begin Step 0 Pre-flight.`;

    console.log(JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: message
      }
    }));

  } catch (error) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  }
}

main();

export { extractPrompt, sanitize, extractFeatureName };
