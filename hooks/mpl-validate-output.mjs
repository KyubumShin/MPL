#!/usr/bin/env node
/**
 * MPL Output Validation Hook (PostToolUse)
 * Inserts validation reminder when a validate_prompt-enabled agent completes.
 *
 * Based on: design doc section 9.2 hook 2 + hoyeon validate_prompt pattern
 *
 * Agents with validate_prompt: pre-execution-analyzer, verification-planner, worker
 * When these agents complete via Task tool, this hook inserts a [MPL VALIDATION] reminder
 * so the orchestrator checks the output against the agent's Output_Schema.
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import shared MPL state utility
const { isMplActive, readState, writeState } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);

// Import shared stdin reader
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);

// Agents that require output validation
export const VALIDATE_AGENTS = new Set([
  'mpl-pre-execution-analyzer',
  'mpl-verification-planner',
  'mpl-worker',
  'mpl-phase-runner',
  'mpl-interviewer',
  'mpl-ambiguity-resolver',
  'mpl-doctor',
  // mpl-critic: absorbed into mpl-decomposer risk_assessment (v3.1)
  'mpl-test-agent',
  'mpl-code-reviewer',
  'mpl-decomposer',
  'mpl-git-master',
  'mpl-compound',
  'mpl-codebase-analyzer',
  'mpl-phase0-analyzer',
  'mpl-qa-agent',              // T-03, v0.5.1 — Browser QA
  'mpl-scout',                 // F-16 — Lightweight exploration
  'mpl-phase-seed-generator',  // D-01, v0.6.0 — Phase Seed generation
]);

// Expected output sections per agent
export const EXPECTED_SECTIONS = {
  'mpl-pre-execution-analyzer': [
    '1. Missing Requirements',
    '2. AI Pitfalls',
    '3. Must NOT Do',
    '4. Recommended Questions',
    '5. Overall Risk Assessment',
    '6. Change-Level Analysis',
    '7. Recommended Execution Order',
  ],
  'mpl-verification-planner': [
    '1. Test Infrastructure',
    '2. A-items',
    '3. S-items',
    '4. H-items',
    '5. Verification Gaps',
    '6. External Dependencies',
  ],
  'mpl-worker': [
    'todo_id',
    'status',
    'outputs',
    'acceptance_criteria',
  ],
  'mpl-phase-runner': [
    'status',
    'state_summary',
    'verification',
  ],
  'mpl-interviewer': [
    'PP-',
    'Priority Order',
    'Interview Metadata',
  ],
  'mpl-ambiguity-resolver': [
    'Ambiguity Score',
    'Dimension Scores',
  ],
  // mpl-critic: removed in v3.1 (absorbed into mpl-decomposer risk_assessment)
  'mpl-test-agent': [
    'phase_id',
    'test_files_created',
    'test_results',
    'a_item_coverage',
  ],
  'mpl-code-reviewer': [
    'Overall Verdict',
    'Findings',
    'Category Summary',
    'Verdict Rationale',
  ],
  'mpl-decomposer': [
    'architecture_anchor',
    'phases',
  ],
  'mpl-git-master': [
    'Commits Created',
  ],
  'mpl-compound': [
    'Learnings',
    'Decisions',
    'Issues',
    'Metrics',
  ],
  'mpl-doctor': [
    'Results',
    'Tool Availability Detail',
    'Recommendations',
    'Summary',
  ],
  'mpl-codebase-analyzer': [
    'project_type',
    'modules',
    'external_deps',
    'test_infrastructure',
  ],
  'mpl-phase0-analyzer': [
    'type-policy',
    'error-spec',
  ],
  'mpl-qa-agent': [
    'status',
    'checks',
  ],
  'mpl-scout': [
    'findings',
    'search_trajectory',  // P-03, v0.8.7 — Search path observability
  ],
  'mpl-phase-seed-generator': [
    'phase_seed',
    'goal',
    'mini_plan_seed',
  ],
};

/**
 * Validate response text against expected sections (case-insensitive).
 * @param {string[]} sections - Expected section names
 * @param {string} responseText - Agent response text
 * @returns {{ passed: boolean, missing: string[], found: string[], sectionList: string }}
 */
export function validateSections(sections, responseText) {
  const missing = [];
  const found = [];
  const lower = responseText.toLowerCase();
  for (const section of sections) {
    if (lower.includes(section.toLowerCase())) {
      found.push(section);
    } else {
      missing.push(section);
    }
  }
  const sectionList = sections.map(s => {
    const ok = found.includes(s);
    return `  - ${ok ? '[PASS]' : '[MISSING]'} ${s}`;
  }).join('\n');
  return { passed: missing.length === 0, missing, found, sectionList };
}

/**
 * Format validation result into a hook message string.
 * @param {string} agentType
 * @param {string[]} sections
 * @param {boolean} passed
 * @param {string[]} missing
 * @param {string} sectionList
 * @returns {string}
 */
export function formatValidationMessage(agentType, sections, passed, missing, sectionList) {
  if (passed) {
    return `[MPL VALIDATION PASSED] Agent "${agentType}" output contains all ${sections.length} required sections.`;
  }
  return `[VALIDATION FAILED] [MPL VALIDATION FAILED] Agent "${agentType}" output is missing ${missing.length}/${sections.length} required sections.

Validation results:
${sectionList}

Missing sections: ${missing.join(', ')}

ACTION REQUIRED: Re-run the agent with clarified instructions targeting the missing sections.
Do NOT proceed to the next phase until all sections are present.`;
}

/**
 * Log a phase profile record to .mpl/mpl/profile/phases.jsonl.
 * @param {string} cwd
 * @param {object} state - current MPL state object
 * @param {string} agentType
 * @param {number} estimatedTokens
 */
function logPhaseProfile(cwd, state, agentType, estimatedTokens) {
  try {
    const profileDir = join(cwd, '.mpl/mpl/profile');
    if (!existsSync(profileDir)) mkdirSync(profileDir, { recursive: true });
    const phaseRecord = {
      step: state.current_phase || 'unknown',
      name: agentType || '',
      pass_rate: null,
      micro_fixes: 0,
      estimated_tokens: { context: 0, output: estimatedTokens, total: estimatedTokens },
      compaction_count: state.compaction_count || 0,
      timestamp: new Date().toISOString(),
    };
    appendFileSync(join(profileDir, 'phases.jsonl'), JSON.stringify(phaseRecord) + '\n');
  } catch {
    // Profile logging is best-effort
  }
}

/**
 * Track token usage for a completed agent task.
 * Updates total_tokens in state and appends to weekly usage log.
 * @param {string} cwd
 * @param {string} agentType
 * @param {string} responseText
 */
function trackTokenUsage(cwd, agentType, responseText) {
  try {
    const estimatedTokens = Math.ceil(responseText.length / 4);
    if (estimatedTokens > 0) {
      const currentState = readState(cwd);
      if (currentState) {
        const currentTokens = currentState.cost?.total_tokens || 0;
        writeState(cwd, { cost: { total_tokens: currentTokens + estimatedTokens } });

        // Weekly usage tracking for HUD
        try {
          const usageDir = join(cwd, '.mpl/usage');
          if (!existsSync(usageDir)) mkdirSync(usageDir, { recursive: true });
          appendFileSync(join(usageDir, 'weekly.jsonl'), JSON.stringify({
            timestamp: new Date().toISOString(),
            tokens: estimatedTokens,
          }) + '\n');
        } catch { /* best-effort */ }

        // Experiment: append compaction_count to phases.jsonl for correlation analysis
        logPhaseProfile(cwd, currentState, agentType, estimatedTokens);
      }
    }
  } catch {
    // Token tracking is best-effort; do not block on failure
  }
}

async function main() {
  const input = await readStdin();

  let data;
  try {
    data = JSON.parse(input);
  } catch {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const toolName = data.tool_name || data.toolName || '';

  // Only intercept Task/Agent tool completions
  if (!['Task', 'task', 'Agent', 'agent'].includes(toolName)) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Check if MPL is active
  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Extract agent type from tool input
  const toolInput = data.tool_input || data.toolInput || {};
  const agentType = toolInput.subagent_type || toolInput.subagentType || '';

  // Track token usage for ALL Task completions (not just validated agents)
  const toolResponse = data.tool_response || data.toolResponse || '';
  const responseText = typeof toolResponse === 'string'
    ? toolResponse
    : JSON.stringify(toolResponse);

  // H2: Estimate token usage from response length and update state
  trackTokenUsage(cwd, agentType, responseText);

  // Validation only applies to agents in VALIDATE_AGENTS
  if (!VALIDATE_AGENTS.has(agentType)) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const sections = EXPECTED_SECTIONS[agentType] || [];
  const { passed, missing, found, sectionList } = validateSections(sections, responseText);
  const message = formatValidationMessage(agentType, sections, passed, missing, sectionList);

  // C3: Block (continue: false) when validation fails
  console.log(JSON.stringify({
    continue: passed,
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: message
    }
  }));
}

main().catch(() => {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
});
