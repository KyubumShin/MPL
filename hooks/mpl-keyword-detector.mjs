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
import { existsSync } from 'fs';

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

    // F-20: Extract tier hint from keywords (bugfix→frugal, small→standard, null→auto)
    let tierHint = null;
    if (/\bmpl[\s-]*(bugfix|fix|bug)\b/i.test(cleanPrompt)) tierHint = 'frugal';
    else if (/\bmpl[\s-]*(small|quick|light)\b/i.test(cleanPrompt)) tierHint = 'standard';

    // Initialize MPL state — always single entry point
    const featureName = extractFeatureName(prompt);
    initState(cwd, featureName, 'auto', tierHint);

    // F-20: Always use single 'mpl' skill — Triage determines tier
    const hintDesc = tierHint ? ` (hint: ${tierHint})` : '';
    const message = `[MAGIC KEYWORD: MPL]

MPL Pipeline activated${hintDesc}. State initialized at .mpl/state.json (run_mode: "auto").
Triage will determine pipeline_tier (frugal/standard/frontier) via Quick Scope Scan.

You MUST invoke the skill using the Skill tool:

Skill: mpl

User request:
${prompt}

IMPORTANT: Load the MPL orchestration protocol via /mpl:mpl-run command, then begin Triage (Step 0).`;

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
