#!/usr/bin/env node
/**
 * MPL Compaction Tracker — thin wrapper (Move #12).
 *
 * Delegates the boundary record + jsonl/checkpoint writes to
 * `lib/observability/trackers.mjs::handleCompactionTracker`. The wrapper
 * applies the side effects the handler returns as intents:
 *   - state.compaction_count += 1                   (always)
 *   - RUNBOOK row append                            (intents[].runbook.append)
 *   - F-38 rotation: predictBudget → session-handoff.json + state flip
 *     when compaction_count >= 3 and budget says non-`continue`, or
 *     compaction_count >= 4 unconditionally        (intents[].rotate.maybe)
 *
 * Legacy verbatim impl preserved in `mpl-compaction-tracker.legacy.mjs`.
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { isMplActive, readState, writeState } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);
const { readStdin } = await import(pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href);
const { handleCompactionTracker } = await import(
  pathToFileURL(join(__dirname, 'lib', 'observability', 'trackers.mjs')).href
);
const { appendRunbookRow, parseRunbookRows, summarizeGates, wallMinutes } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-runbook.mjs')).href
);

async function main() {
  const input = await readStdin();
  let data;
  try { data = JSON.parse(input); } catch { return; }

  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) return;
  const state = readState(cwd);
  if (!state) return;

  // Runbook snapshot BEFORE the handler's file writes (legacy order).
  try {
    const rows = parseRunbookRows(cwd);
    const startedAt = (rows[0]?.ended_at) || state?.started_at || '';
    const mark = `compaction-${(state.compaction_count || 0) + 1}`;
    appendRunbookRow(cwd, {
      phase: `${state.current_phase || 'unknown'} (${mark})`,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      gates: summarizeGates(state),
      wall_min: wallMinutes(startedAt, new Date().toISOString()),
      fix_loops: state.fix_loop_count || 0,
    });
  } catch { /* non-fatal */ }

  const decision = handleCompactionTracker({ cwd, state, raw: data });
  if (!decision || decision.action !== 'tracked') return;

  // Apply state increment.
  if (decision.stateMutations) writeState(cwd, decision.stateMutations);

  // F-38 rotation: consult budget predictor + flip state.
  const rotate = (decision.intents || []).find((i) => i && i.kind === 'rotate.maybe');
  if (rotate) {
    try {
      const { predictBudget } = await import(
        pathToFileURL(join(__dirname, 'lib', 'mpl-budget-predictor.mjs')).href
      );
      const budget = predictBudget(cwd);
      if (budget.recommendation !== 'continue' || rotate.hard_limit) {
        const signalsDir = join(cwd, '.mpl', 'signals');
        if (!existsSync(signalsDir)) mkdirSync(signalsDir, { recursive: true });
        const handoff = {
          pipeline_id: state.pipeline_id || null,
          resume_from_phase: state.current_phase,
          completed_phases: state.phases_completed || 0,
          remaining_phases: [],
          rotation_count: state.rotation_count || 0,
          pause_reason: rotate.hard_limit
            ? `compaction_limit_exceeded (${rotate.compaction_count})`
            : `budget_insufficient (${budget.remaining_pct}% remaining, ${budget.estimated_needed_pct}% needed)`,
          budget_snapshot: budget,
          timestamp: new Date().toISOString(),
        };
        writeFileSync(join(signalsDir, 'session-handoff.json'), JSON.stringify(handoff, null, 2) + '\n');
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
