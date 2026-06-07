#!/usr/bin/env node
/**
 * MPL Require Goal Trace Hook (PreToolUse on Write|Edit|MultiEdit).
 *
 * Thin delegating wrapper around `policy/contracts.mjs#handleGoalTrace`.
 * The legacy implementation is preserved at `mpl-require-goal-trace.legacy.mjs`
 * for emergency rollback. The legacy stdout shape (block reason text,
 * state.json companion fields) is reproduced here so callers — Claude Code's
 * hook runner and the test suite — keep seeing the same contract.
 */
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;

const { isMplActive, readState } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href);
const { loadConfig } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-config.mjs')).href);
const { readBaselineGoalContractHash, readGoalContract } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-goal-contract.mjs')).href);
const { collectFileWrites, isFileWriteTool } = await import(
  pathToFileURL(join(__dirname, 'lib', 'tool-input.mjs')).href);
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href);
const { recordBlockedHook, clearBlockedHook } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-blocked-hook.mjs')).href);
const { handleGoalTrace } = await import(
  pathToFileURL(join(__dirname, 'lib', 'policy', 'contracts.mjs')).href);

const HOOK_ID = 'mpl-require-goal-trace';
const BLOCKED_ARTIFACT = '.mpl/mpl/decomposition.yaml';

const ok = () => console.log(JSON.stringify({ continue: true, suppressOutput: true }));
const block = (reason) => console.log(JSON.stringify({ continue: false, decision: 'block', reason }));

export function targetsDecompositionFile(filePath) {
  return typeof filePath === 'string' && /(^|\/)\.mpl\/mpl\/decomposition\.ya?ml$/.test(filePath);
}

function decompositionWrites(toolInput) {
  return collectFileWrites(toolInput).filter(
    (e) => targetsDecompositionFile(e.filePath) && e.text);
}

/**
 * Policy's `collectDecompositionTexts` ignores per-edit payloads when only
 * the top-level path is set (Claude's MultiEdit shape). Stitch the edit
 * payloads into `content` so the same texts get validated.
 */
function normalizeToolInputForPolicy(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return toolInput;
  const writes = decompositionWrites(toolInput);
  if (writes.length === 0) return toolInput;
  if (typeof toolInput.content === 'string' ||
      typeof toolInput.new_string === 'string' ||
      typeof toolInput.newString === 'string') return toolInput;
  return {
    ...toolInput,
    file_path: toolInput.file_path || toolInput.filePath || writes[0].filePath,
    content: writes.map((w) => w.text).join('\n'),
  };
}

/**
 * Per-code translation tables that re-expand the policy decision into the
 * legacy contract. Each entry returns { reason, resume, retry }. The wrapper
 * exists for exactly this: rebuild messages the policy module condensed so
 * specific test phrases (e.g. "raw shasum may differ", baseline rawHash on
 * corruption) stay in the stdout.
 */
function legacyEnvelope(decision, cwd) {
  const rc = decision.retryContext || {};
  const base = { target: BLOCKED_ARTIFACT, goal_contract_path: '.mpl/goal-contract.yaml' };
  switch (decision.code) {
    case 'goal_contract_invalid': {
      const missing = rc.missing || [];
      return {
        reason: `[MPL Goal Trace] Cannot write decomposition.yaml — goal contract missing or invalid: ${missing.join(', ')}.`,
        resume: 'Restore a valid .mpl/goal-contract.yaml, then retry the decomposition write.',
        retry: { ...base, missing },
      };
    }
    case 'goal_contract_baseline_corrupt': {
      const baseline = readBaselineGoalContractHash(cwd);
      const err = baseline.error || rc.baseline_error || 'unknown';
      const raw = baseline.rawHash ? `: ${baseline.rawHash}` : '';
      return {
        reason:
          `[MPL Goal Trace] Cannot write decomposition.yaml — corrupt baseline.yaml goal_contract sha256 ` +
          `(${err}${raw}). ` +
          `Expected the 64-character lowercase normalized SHA-256 for .mpl/goal-contract.yaml. ` +
          `Raw shasum may differ because MPL normalizes CRLF to LF and trims surrounding whitespace before hashing. ` +
          `Re-run Phase 0 renewal before recomposing.`,
        resume: 'Re-run Phase 0 renewal so baseline.yaml records a valid goal_contract sha256, then retry decomposition.',
        retry: { ...base, baseline_error: rc.baseline_error || baseline.error, raw_hash: baseline.rawHash || null },
      };
    }
    case 'goal_contract_drift':
      return {
        reason:
          `[MPL Goal Trace] Cannot write decomposition.yaml — .mpl/goal-contract.yaml drifted from baseline.yaml ` +
          `(baseline=${rc.baseline_hash || ''}, current=${rc.current_hash || ''}). ` +
          `These are MPL normalized hashes; raw shasum may differ because MPL normalizes CRLF to LF and trims surrounding whitespace. ` +
          `Re-run Phase 0 renewal before recomposing.`,
        resume: 'Resolve the Goal Contract drift via Phase 0 renewal before recomposing decomposition.yaml.',
        retry: { ...base, baseline_hash: rc.baseline_hash, current_hash: rc.current_hash },
      };
    case 'goal_trace_incomplete': {
      const issues = rc.issues || [];
      const count = rc.issue_count ?? issues.length;
      const shown = issues.slice(0, 12).join(', ');
      const more = count > 12 ? ` (+${count - 12} more)` : '';
      return {
        reason:
          `[MPL Goal Trace] decomposition.yaml does not cover the frozen Goal Contract: ${shown}${more}. ` +
          `Each phase needs goal_trace and the graph must cover every AC/AX from .mpl/goal-contract.yaml ` +
          `(including the MVP subset when mvp_scope is declared).`,
        resume: 'Add or fix per-phase goal_trace coverage for every required AC/AX, including MVP subset coverage when declared, then retry decomposition.',
        retry: { ...base, issue_count: count, issues },
      };
    }
    default:
      return {
        reason: decision.reason || 'Goal trace contract violation.',
        resume: decision.resumeInstruction || 'Resolve the recorded contract violation, then retry.',
        retry: { ...base, ...rc },
      };
  }
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return ok();

  let data;
  try { data = JSON.parse(raw); } catch { return ok(); }

  const toolName = data.tool_name || data.toolName || '';
  if (!isFileWriteTool(toolName)) return ok();

  const toolInput = data.tool_input || data.toolInput || {};
  if (decompositionWrites(toolInput).length === 0) return ok();

  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) return ok();

  const config = loadConfig(cwd);
  // Legacy opt-out flags short-circuit before the policy module so a
  // workspace that disabled this contract never pays for the validation.
  if (config.goal_contract_required === false || config.goal_trace_required === false) {
    clearBlockedHook(cwd, { hookId: HOOK_ID, artifact: BLOCKED_ARTIFACT });
    return ok();
  }

  const state = readState(cwd);
  const decision = await handleGoalTrace({
    cwd,
    state,
    config,
    toolName,
    toolInput: normalizeToolInputForPolicy(toolInput),
    hookEvent: data.hook_event_name || data.hookEvent || 'PreToolUse',
  });

  if (decision.action === 'block') {
    const { reason, resume, retry } = legacyEnvelope(decision, cwd);
    recordBlockedHook(cwd, {
      hookId: HOOK_ID,
      artifact: BLOCKED_ARTIFACT,
      code: decision.code,
      reason,
      resumeInstruction: resume,
      retryContext: retry,
    });
    block(reason);
    return;
  }

  clearBlockedHook(cwd, { hookId: HOOK_ID, artifact: BLOCKED_ARTIFACT });
  ok();
}

// Re-export for callers / tests that import this module directly.
export { readGoalContract };

if (isMain) {
  await main().catch(() => ok());
}
