#!/usr/bin/env node
/**
 * MPL Compaction Tracker (PreCompact hook)
 * Tracks compaction events for the token budget experiment.
 * Records compaction count in state and logs to compactions.jsonl.
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync, appendFileSync, mkdirSync, writeFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { isMplActive, readState, writeState } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);

const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);

const PROFILE_DIR = '.mpl/mpl/profile';
const COMPACTIONS_FILE = 'compactions.jsonl';
const CHECKPOINTS_DIR = '.mpl/mpl/checkpoints';

async function main() {
  const input = await readStdin();

  let data;
  try {
    data = JSON.parse(input);
  } catch {
    // No valid input, skip
    return;
  }

  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) return;

  const state = readState(cwd);
  if (!state) return;

  // Increment compaction count in state
  const currentCount = state.compaction_count || 0;
  const newCount = currentCount + 1;
  writeState(cwd, { compaction_count: newCount });

  // Log to compactions.jsonl
  const profileDir = join(cwd, PROFILE_DIR);
  if (!existsSync(profileDir)) {
    mkdirSync(profileDir, { recursive: true });
  }

  const record = {
    timestamp: new Date().toISOString(),
    pipeline_id: state.pipeline_id || null,
    compaction_count: newCount,
    trigger: data.trigger || 'unknown',
    current_phase: state.current_phase || null,
    total_tokens_at_compaction: state.cost?.total_tokens || 0,
    fix_loop_count: state.fix_loop_count || 0,
  };

  appendFileSync(
    join(profileDir, COMPACTIONS_FILE),
    JSON.stringify(record) + '\n'
  );

  // Create compaction checkpoint file
  const checkpointsDir = join(cwd, CHECKPOINTS_DIR);
  if (!existsSync(checkpointsDir)) {
    mkdirSync(checkpointsDir, { recursive: true });
  }

  const checkpointContent = [
    `# Compaction Checkpoint #${newCount}`,
    `- **Timestamp**: ${record.timestamp}`,
    `- **Current Phase**: ${record.current_phase}`,
    `- **Compaction Count**: ${newCount}`,
    `- **Context Usage**: triggered at ~83.5%`,
    ``,
    `## Recovery Instructions`,
    `Resume from current phase. Read state-summary.md from previous phases if context was lost.`,
  ].join('\n');

  writeFileSync(
    join(checkpointsDir, `compaction-${newCount}.md`),
    checkpointContent + '\n'
  );

  // F-38: Auto context rotation — write handoff signal on high compaction count
  // or when budget predictor recommends pause
  if (newCount >= 3) {
    try {
      // Import budget predictor
      const { predictBudget } = await import(
        pathToFileURL(join(__dirname, 'lib', 'mpl-budget-predictor.mjs')).href
      );

      const budget = predictBudget(cwd);

      // Write handoff signal if budget is insufficient or compaction is excessive
      if (budget.recommendation !== 'continue' || newCount >= 4) {
        const signalsDir = join(cwd, '.mpl', 'signals');
        if (!existsSync(signalsDir)) mkdirSync(signalsDir, { recursive: true });

        const handoff = {
          pipeline_id: state.pipeline_id || null,
          resume_from_phase: state.current_phase,
          completed_phases: state.phases_completed || 0,
          remaining_phases: [], // will be filled by orchestrator if available
          rotation_count: state.rotation_count || 0,
          pause_reason: newCount >= 4
            ? `compaction_limit_exceeded (${newCount})`
            : `budget_insufficient (${budget.remaining_pct}% remaining, ${budget.estimated_needed_pct}% needed)`,
          budget_snapshot: budget,
          timestamp: new Date().toISOString(),
        };

        writeFileSync(
          join(signalsDir, 'session-handoff.json'),
          JSON.stringify(handoff, null, 2) + '\n'
        );

        // Update state for resume
        writeState(cwd, {
          session_status: 'paused_budget',
          pause_reason: handoff.pause_reason,
          rotation_count: (state.rotation_count || 0) + 1,
        });

        console.error(`[MPL] Context rotation triggered: ${handoff.pause_reason}`);
      }
    } catch (err) {
      console.error(`[mpl-compaction-tracker] rotation signal failed: ${err.message}`);
    }
  }
}

main().catch((err) => {
  process.stderr.write('[mpl-compaction-tracker] checkpoint write failed: ' + err.message + '\n');
});
