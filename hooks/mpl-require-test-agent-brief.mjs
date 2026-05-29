#!/usr/bin/env node
/**
 * Exp22 R12 / #212 MVP — block `Task(subagent_type='mpl-test-agent')`
 * dispatches when the phase is marked `test_agent_required: true` and
 * `.mpl/mpl/phases/{phase_id}/test-agent-brief.yaml` is missing or
 * fails the brief schema validation.
 *
 * The brief contract (`docs/schemas/test-agent-brief.md`) decouples
 * the test-agent execution runbook from the decomposer's
 * responsibility surface. The brief generator (a new agent or a
 * mpl-seed-generator extension) is deferred to a follow-up — the MVP
 * just enforces the validated artifact must be present before the
 * test-agent can be dispatched.
 *
 * Wired in `hooks/hooks.json` as PreToolUse on Task|Agent. Returns
 * `{ continue: false, decision: 'block', reason }` when the brief is
 * missing/invalid. All other paths (non-test-agent dispatch,
 * test_agent_required:false phase, valid brief) pass silently.
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync, readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;

const { readState, isMplActive } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);
const { validateBrief } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-test-agent-brief.mjs')).href
);
const { writeTestAgentBriefs } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-decomposition-postprocess.mjs')).href
);
const { loadConfig } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-config.mjs')).href
);
// #235: the hook's own enforcement.json mode resolves to off/warn/block,
// but the block path previously bypassed recordBlockedHook. Wire envelope.
const { recordBlockedHook, clearBlockedHook } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-blocked-hook.mjs')).href
);
// readState is already imported above with isMplActive.

const HOOK_ID = 'mpl-require-test-agent-brief';

function silent() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

function warn(reason) {
  console.log(JSON.stringify({ continue: true, systemMessage: reason }));
}

function block(reason) {
  console.log(JSON.stringify({ continue: false, decision: 'block', reason }));
}

/**
 * #225 cutover: the producer (mechanical postprocess in
 * hooks/lib/mpl-decomposition-postprocess.mjs::writeTestAgentBriefs)
 * now ships briefs whenever decomposition.yaml changes, so the
 * default flips from `warn` to `block`. Operators can still set
 * `.mpl/config/test-agent-brief-enforcement.json` to `{ "mode": "warn" }`
 * or `{ "mode": "off" }` for transitional / debugging needs.
 *
 * History: PR #224 (Codex r2 [contract-break]) introduced the config
 * file with a `warn` default because the brief producer was deferred.
 * That deferral closes here.
 */
function resolveEnforcementMode(cwd) {
  const cfgPath = join(cwd, '.mpl', 'config', 'test-agent-brief-enforcement.json');
  if (!existsSync(cfgPath)) return 'block';
  try {
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    const mode = String(parsed?.mode || '').toLowerCase();
    if (mode === 'block' || mode === 'warn' || mode === 'off') return mode;
  } catch { /* fall through */ }
  return 'block';
}

function surface(cwd, mode, { reason, phaseId, code, retryContext = {} }) {
  // Codex r1 on PR #246: clear any stale envelope on off/warn/silent
  // paths; record envelope on block before printing the response.
  const artifact = phaseId
    ? `.mpl/mpl/phases/${phaseId}/test-agent-brief.yaml`
    : 'test-agent-brief';
  if (mode === 'off') {
    clearBlockedHook(cwd, { hookId: HOOK_ID, artifact });
    return silent();
  }
  if (mode === 'block') {
    const state = readState(cwd) || {};
    recordBlockedHook(cwd, {
      hookId: HOOK_ID,
      phaseId,
      artifact,
      code,
      reason,
      resumeInstruction:
        `Generate a valid ${artifact} (or fix its schema validation), then retry the mpl-test-agent dispatch.`,
      retryContext,
    });
    return block(reason);
  }
  clearBlockedHook(cwd, { hookId: HOOK_ID, artifact });
  warn(reason);
}

function extractPhaseId(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/\bphase-(\d+)\b/);
  return m ? `phase-${m[1]}` : null;
}

/**
 * Minimal decomposition.yaml peek: find the entry for `phaseId` and
 * return its `test_agent_required` boolean (default `true` per AD-0007
 * — Decomposer must actively mark `false` with rationale).
 */
function readTestAgentRequired(cwd, phaseId) {
  const path = join(cwd, '.mpl', 'mpl', 'decomposition.yaml');
  if (!existsSync(path)) return null;
  let text;
  try { text = readFileSync(path, 'utf-8'); } catch { return null; }

  const idMatch = new RegExp(`(^|\\n)\\s*-\\s*id\\s*:\\s*${phaseId}\\b`).exec(text);
  if (!idMatch) return null;
  // Walk forward from the phase id line until we hit the next sibling
  // `- id:` or the end of the file.
  const tail = text.slice(idMatch.index);
  const nextSibling = tail.slice(1).search(/\n\s*-\s*id\s*:/);
  const phaseBlock = nextSibling === -1 ? tail : tail.slice(0, nextSibling + 1);
  const flagMatch = phaseBlock.match(/^\s*test_agent_required\s*:\s*(true|false)/im);
  if (!flagMatch) {
    // #240 A2 + codex/claude r3 on PR #244 [contract-break]: respect
    // the workspace config knob when the phase omits the field.
    try {
      const cfg = loadConfig(cwd);
      if (cfg?.test_agent?.default_required === false) return false;
    } catch { /* fall through to strict default */ }
    return true; // default: required (AD-0007)
  }
  return flagMatch[1].toLowerCase() === 'true';
}

function briefPath(cwd, phaseId) {
  return join(cwd, '.mpl', 'mpl', 'phases', phaseId, 'test-agent-brief.yaml');
}

function buildReason(phaseId, reason, errors) {
  const path = `.mpl/mpl/phases/${phaseId}/test-agent-brief.yaml`;
  const errs = (errors && errors.length) ? `\n  - ${errors.join('\n  - ')}` : '';
  return (
    `[MPL #212] mpl-test-agent dispatch for ${phaseId} blocked: ${reason}. ` +
    `Phase has \`test_agent_required: true\` per decomposition.yaml; ` +
    `\`${path}\` is the required execution runbook (see ` +
    `docs/schemas/test-agent-brief.md).${errs}`
  );
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return silent();

  let data;
  try { data = JSON.parse(raw); } catch { return silent(); }

  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) return silent();

  const toolName = String(data.tool_name || data.toolName || '');
  if (!['Task', 'Agent'].includes(toolName)) return silent();

  const toolInput = data.tool_input || data.toolInput || {};
  const subagent = String(toolInput.subagent_type || toolInput.subagentType || '');
  if (!/mpl-test-agent$/.test(subagent)) return silent();

  // No background bypass here — codex r1 on PR #224. This hook is
  // PreToolUse; if we skipped on `run_in_background`, the background
  // dispatch would launch without a brief check and no later PreToolUse
  // event can stop the already-started run. The brief precondition
  // must be enforced for foreground AND background dispatches.
  // (The PostToolUse mpl-require-test-agent hook has its own handle-stub
  // heuristic — that's separate, because it's reasoning about a
  // tool_response that doesn't exist at this point in the lifecycle.)

  const phaseId = extractPhaseId(toolInput.prompt || toolInput.description || '');
  if (!phaseId) return silent(); // non-phase task, conservative allow

  const required = readTestAgentRequired(cwd, phaseId);
  if (required === false) {
    // Explicit opt-out — clear any stale envelope.
    clearBlockedHook(cwd, {
      hookId: HOOK_ID,
      artifact: `.mpl/mpl/phases/${phaseId}/test-agent-brief.yaml`,
    });
    return silent();
  }
  // null (decomposition not yet available) also passes — defer to
  // existing require-test-agent hook to handle that case.
  if (required === null) return silent();

  const mode = resolveEnforcementMode(cwd);
  if (mode === 'off') {
    clearBlockedHook(cwd, {
      hookId: HOOK_ID,
      artifact: `.mpl/mpl/phases/${phaseId}/test-agent-brief.yaml`,
    });
    return silent();
  }

  const path = briefPath(cwd, phaseId);
  if (!existsSync(path)) {
    // Codex r1 on PR #226 [contract-break]: pre-#225 workspaces can have a
    // decomposition.yaml without briefs. The producer normally runs as a
    // PostToolUse on decomposition writes, but a workspace that hasn't
    // re-saved decomposition.yaml since #225 landed has no triggered
    // generation yet. Try lazy generation here — if it succeeds for this
    // phase, the gate proceeds. Failure paths still surface the diagnostic.
    try { writeTestAgentBriefs(cwd); } catch { /* fall through to missing diagnostic */ }
    if (!existsSync(path)) {
      surface(cwd, mode, {
        reason: buildReason(phaseId, 'brief artifact missing'),
        phaseId,
        code: 'test_agent_brief_missing',
        retryContext: { brief_path: `.mpl/mpl/phases/${phaseId}/test-agent-brief.yaml` },
      });
      return;
    }
  }
  let text;
  try { text = readFileSync(path, 'utf-8'); } catch (e) {
    surface(cwd, mode, {
      reason: buildReason(phaseId, `brief artifact unreadable: ${e?.message || 'unknown'}`),
      phaseId,
      code: 'test_agent_brief_unreadable',
      retryContext: { error: e?.message || 'unknown' },
    });
    return;
  }
  const { valid, errors } = validateBrief(text, { phaseId });
  if (!valid) {
    surface(cwd, mode, {
      reason: buildReason(phaseId, 'brief failed schema validation', errors),
      phaseId,
      code: 'test_agent_brief_invalid',
      retryContext: { errors: (errors || []).slice(0, 20) },
    });
    return;
  }
  // Success — clear any stale envelope tagged to this brief artifact.
  clearBlockedHook(cwd, {
    hookId: HOOK_ID,
    artifact: `.mpl/mpl/phases/${phaseId}/test-agent-brief.yaml`,
  });
  silent();
}

if (isMain) {
  await main().catch(() => silent());
}
