#!/usr/bin/env node
/**
 * MPL Session Init Hook (F-38)
 * Fires on SessionStart. Detects if this is a post-rotation restart
 * and injects resume context.
 *
 * Detection: .mpl/signals/session-handoff.json exists + is recent (<120s)
 */
import { existsSync, readFileSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';

const HANDOFF_MAX_AGE_MS = 120000; // 120s - handoff signal must be recent

async function main() {
  // SessionStart hook receives minimal input (may be empty or have cwd)
  let cwd = process.cwd();

  // Try to read stdin for cwd
  try {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const input = Buffer.concat(chunks).toString('utf-8').trim();
    if (input) {
      const data = JSON.parse(input);
      cwd = data.cwd || data.directory || cwd;
    }
  } catch { /* use process.cwd() */ }

  const signalFile = join(cwd, '.mpl', 'signals', 'session-handoff.json');

  // Check if handoff signal exists
  if (!existsSync(signalFile)) {
    // No rotation in progress - normal session start
    return;
  }

  // Check signal freshness
  try {
    const stat = statSync(signalFile);
    const age = Date.now() - stat.mtimeMs;
    if (age > HANDOFF_MAX_AGE_MS) {
      // Stale signal - ignore (probably from a previous failed rotation)
      return;
    }
  } catch {
    return;
  }

  // Read handoff data
  let handoff;
  try {
    handoff = JSON.parse(readFileSync(signalFile, 'utf-8'));
  } catch {
    return;
  }

  // Clean up signal file (consumed)
  try { unlinkSync(signalFile); } catch { /* ignore */ }

  // Read current state for context
  let state = {};
  try {
    const statePath = join(cwd, '.mpl', 'state.json');
    if (existsSync(statePath)) {
      state = JSON.parse(readFileSync(statePath, 'utf-8'));
    }
  } catch { /* ignore */ }

  // Read PLAN.md summary for context
  let planSummary = '';
  try {
    const planPath = join(cwd, '.mpl', 'PLAN.md');
    if (existsSync(planPath)) {
      const plan = readFileSync(planPath, 'utf-8');
      // Extract first 2000 chars as summary
      planSummary = plan.substring(0, 2000);
    }
  } catch { /* ignore */ }

  // Build resume context message
  const resumePhase = handoff.resume_from_phase || state.current_phase || 'unknown';
  const pipelineId = handoff.pipeline_id || state.pipeline_id || 'unknown';
  const completedPhases = handoff.completed_phases || state.phases_completed || 0;
  const remainingPhases = handoff.remaining_phases || [];
  const rotationCount = handoff.rotation_count || 0;

  // Build context for the model
  const contextMessage = [
    `[MPL Auto-Resume] Context rotation #${rotationCount + 1} completed.`,
    ``,
    `Pipeline: ${pipelineId}`,
    `Resume from: ${resumePhase}`,
    `Completed phases: ${completedPhases}`,
    remainingPhases.length > 0 ? `Remaining: ${remainingPhases.join(', ')}` : '',
    ``,
    `State file: .mpl/state.json`,
    `Plan file: .mpl/PLAN.md`,
    ``,
    `IMPORTANT: This is an automatic context rotation. The pipeline was paused due to context window limits.`,
    `Execute /mpl:mpl-resume to continue the pipeline from ${resumePhase}.`,
    ``,
    planSummary ? `--- PLAN.md Preview ---\n${planSummary}\n--- End Preview ---` : '',
  ].filter(Boolean).join('\n');

  // Output as system message for context injection
  console.log(JSON.stringify({
    systemMessage: contextMessage,
  }));
}

main().catch(() => {
  // Silent failure - don't break session start
});
