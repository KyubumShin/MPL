/**
 * MPL Session Init Policy (Move #14 Part 2)
 *
 * SessionStart-event handler. Owns the handoff-detection + resume-context
 * body extracted from the legacy hooks/mpl-session-init.mjs (lines 106-189).
 *
 * Pure policy: reads `.mpl/signals/session-handoff.json` (with 120s freshness
 * check), unlinks the signal once consumed, reads `.mpl/state.json` and the
 * first 2000 chars of `.mpl/PLAN.md`, then composes the [MPL Auto-Resume]
 * message that is surfaced to the model via both:
 *   - top-level `systemMessage` (Dialect A)
 *   - `hookSpecificOutput.additionalContext` (Dialect B)
 *
 * SessionStart is dialect AB so the engine's aggregate() routes both keys.
 *
 * `requireMplActive: false` because handoff detection must run even when MPL
 * is inactive (a rotation may have happened in a pre-active state, and we
 * still want to inject the resume context).
 *
 * Fail-soft: every I/O path is wrapped in try/catch and the handler returns
 * `{ action: 'noop' }` on any error — preserving the legacy
 * `main().catch(()=>{})` silent-never-break-session-start guarantee.
 */

import { existsSync, readFileSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';

const HANDOFF_MAX_AGE_MS = 120000; // 120s — handoff signal must be recent

/**
 * Read + consume the handoff signal at `.mpl/signals/session-handoff.json`.
 * Returns the composed resume context string, or null when no actionable
 * signal exists (missing, stale, or unparseable).
 */
export function readAndConsumeHandoff(cwd, stateInput) {
  if (!cwd) return null;
  const signalFile = join(cwd, '.mpl', 'signals', 'session-handoff.json');
  if (!existsSync(signalFile)) return null;

  // Freshness check — stale signals from a previous failed rotation are ignored.
  try {
    const stat = statSync(signalFile);
    const age = Date.now() - stat.mtimeMs;
    if (age > HANDOFF_MAX_AGE_MS) return null;
  } catch {
    return null;
  }

  let handoff;
  try {
    handoff = JSON.parse(readFileSync(signalFile, 'utf-8'));
  } catch {
    return null;
  }

  // Consume the signal — best-effort unlink.
  try { unlinkSync(signalFile); } catch { /* ignore */ }

  // Read state for context. Prefer the engine-passed state when available so
  // we don't double-read.
  let state = stateInput || {};
  if (!stateInput) {
    try {
      const statePath = join(cwd, '.mpl', 'state.json');
      if (existsSync(statePath)) {
        state = JSON.parse(readFileSync(statePath, 'utf-8'));
      }
    } catch { /* ignore */ }
  }

  // Read PLAN.md preview.
  let planSummary = '';
  try {
    const planPath = join(cwd, '.mpl', 'PLAN.md');
    if (existsSync(planPath)) {
      const plan = readFileSync(planPath, 'utf-8');
      planSummary = plan.substring(0, 2000);
    }
  } catch { /* ignore */ }

  const resumePhase = handoff.resume_from_phase || state.current_phase || 'unknown';
  const pipelineId = handoff.pipeline_id || state.pipeline_id || 'unknown';
  const completedPhases = handoff.completed_phases || state.phases_completed || 0;
  const remainingPhases = handoff.remaining_phases || [];
  const rotationCount = handoff.rotation_count || 0;

  return [
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
}

/**
 * Policy entrypoint for the SessionStart event.
 *
 * Combines the first-install mcp-server bootstrap notice (when applicable)
 * with the handoff resume context (when a fresh signal exists).
 *
 * @param {{ event?: string, cwd: string, state?: object, config?: object,
 *           mplActive?: boolean, raw?: object }} ctx
 * @returns {Promise<{ action: 'noop' } |
 *                   { action: 'allow', ruleId: string, systemMessage: string,
 *                     additionalContext: string }>}
 */
export async function handle(ctx) {
  const cwd = ctx?.cwd || process.cwd();

  // (1) MCP-server first-install bootstrap notice. Best-effort import so a
  // missing observability/ module degrades to no notice rather than crashing
  // the session start.
  let notice = null;
  try {
    const mod = await import('../observability/bootstrap.mjs');
    if (mod && typeof mod.ensureMcpServerBuilt === 'function') {
      notice = mod.ensureMcpServerBuilt();
    }
  } catch {
    notice = null;
  }

  // (2) Handoff detection + resume context body.
  let resume = null;
  try {
    resume = readAndConsumeHandoff(cwd, ctx?.state);
  } catch {
    resume = null;
  }

  if (!notice && !resume) return { action: 'noop' };

  const systemMessage = [notice, resume].filter(Boolean).join('\n');
  return {
    action: 'allow',
    ruleId: 'session_resume_context',
    systemMessage,
    additionalContext: systemMessage,
  };
}
