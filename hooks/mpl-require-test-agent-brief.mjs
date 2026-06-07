#!/usr/bin/env node
/**
 * Exp22 R12 / #212 — PreToolUse gate for `Task(subagent_type='mpl-test-agent')`
 * dispatches. Now a thin wrapper that delegates the core allow/block
 * decision to `hooks/lib/policy/contracts.mjs::handleTestAgentBrief`.
 *
 * The wrapper retains the legacy concerns that are NOT part of the
 * pure decision (they are operational side-effects / formatting):
 *
 *   1. `.mpl/config/test-agent-brief-enforcement.json` mode resolution
 *      (off | warn | block). The policy module assumes block-or-allow;
 *      this hook still honors warn (systemMessage) and off (silent).
 *
 *   2. Lazy `writeTestAgentBriefs(cwd)` invocation when the brief is
 *      missing. Pre-#225 workspaces have no triggered generation yet —
 *      we try once before surfacing the diagnostic.
 *
 *   3. `recordBlockedHook` / `clearBlockedHook` envelope side-effects.
 *
 *   4. Legacy stdout shape:
 *        - block → `{ continue: false, decision: 'block', reason }`
 *        - warn  → `{ continue: true, systemMessage: reason }`
 *        - off / allow → `{ continue: true, suppressOutput: true }`
 *
 *   5. `buildReason()` formatting (includes the artifact path AND the
 *      schema error bullets that the policy module collapses into a
 *      single `;`-joined string). Tests assert both the artifact path
 *      substring and per-error tokens.
 *
 * The legacy implementation is preserved as
 * `mpl-require-test-agent-brief.legacy.mjs` for emergency rollback.
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
const { writeTestAgentBriefs } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-decomposition-postprocess.mjs')).href
);
const { loadConfig } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-config.mjs')).href
);
const { recordBlockedHook, clearBlockedHook } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-blocked-hook.mjs')).href
);
const { handleTestAgentBrief } = await import(
  pathToFileURL(join(__dirname, 'lib', 'policy', 'contracts.mjs')).href
);

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

function extractPhaseId(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/\bphase-(\d+)\b/);
  return m ? `phase-${m[1]}` : null;
}

function buildReason(phaseId, summary, errors) {
  const path = `.mpl/mpl/phases/${phaseId}/test-agent-brief.yaml`;
  const errs = (errors && errors.length) ? `\n  - ${errors.join('\n  - ')}` : '';
  return (
    `[MPL #212] mpl-test-agent dispatch for ${phaseId} blocked: ${summary}. ` +
    `Phase has \`test_agent_required: true\` per decomposition.yaml; ` +
    `\`${path}\` is the required execution runbook (see ` +
    `docs/schemas/test-agent-brief.md).${errs}`
  );
}

/**
 * Translate a policy `block` envelope's `code` + `retryContext` back
 * into the legacy `buildReason()` text (which tests assert against
 * specific substrings — artifact path, per-error tokens, etc.).
 */
function legacyReasonFromDecision(decision, phaseId) {
  const code = decision.code || 'test_agent_brief_invalid';
  const ctx = decision.retryContext || {};
  if (code === 'test_agent_brief_missing') {
    return buildReason(phaseId, 'brief artifact missing');
  }
  if (code === 'test_agent_brief_unreadable') {
    return buildReason(phaseId, `brief artifact unreadable: ${ctx.error || 'unknown'}`);
  }
  // schema-invalid path (includes ctx.errors)
  return buildReason(phaseId, 'brief failed schema validation', ctx.errors || []);
}

function surface(cwd, mode, { reason, phaseId, code, retryContext = {} }) {
  const artifact = phaseId
    ? `.mpl/mpl/phases/${phaseId}/test-agent-brief.yaml`
    : 'test-agent-brief';
  if (mode === 'off') {
    clearBlockedHook(cwd, { hookId: HOOK_ID, artifact });
    return silent();
  }
  if (mode === 'block') {
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

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return silent();

  let data;
  try { data = JSON.parse(raw); } catch { return silent(); }

  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) return silent();

  const toolName = String(data.tool_name || data.toolName || '');
  const toolInput = data.tool_input || data.toolInput || {};
  const subagent = String(toolInput.subagent_type || toolInput.subagentType || '');

  // Early non-target filters: same as legacy. These also short-circuit
  // before policy delegation so we can guarantee a `silent()` response
  // (the policy returns `allow` which we map to silent anyway, but
  // bailing early avoids unnecessary I/O).
  if (!['Task', 'Agent'].includes(toolName)) return silent();
  if (!/mpl-test-agent$/.test(subagent)) return silent();

  const phaseId = extractPhaseId(toolInput.prompt || toolInput.description || '');
  if (!phaseId) return silent();

  const mode = resolveEnforcementMode(cwd);
  const artifact = `.mpl/mpl/phases/${phaseId}/test-agent-brief.yaml`;
  if (mode === 'off') {
    clearBlockedHook(cwd, { hookId: HOOK_ID, artifact });
    return silent();
  }

  // Lazy producer: pre-#225 workspaces with decomposition.yaml but no
  // briefs get one generation attempt before the gate fires.
  const briefAbs = join(cwd, artifact);
  if (!existsSync(briefAbs)) {
    try { writeTestAgentBriefs(cwd); } catch { /* fall through */ }
  }

  // Delegate the decision. `loadConfig` may throw on malformed files;
  // policy handler accepts a missing config (treats undefined paths as
  // defaults), so swallow errors and pass {} on failure.
  let config = {};
  try { config = loadConfig(cwd) || {}; } catch { config = {}; }
  const state = readState(cwd) || {};

  const decision = await handleTestAgentBrief({
    cwd,
    toolName,
    toolInput,
    state,
    config,
    hookEvent: 'PreToolUse',
  });

  if (decision.action === 'allow') {
    clearBlockedHook(cwd, { hookId: HOOK_ID, artifact });
    return silent();
  }

  // action === 'block' — translate to legacy stdout + envelope.
  const reason = legacyReasonFromDecision(decision, phaseId);
  surface(cwd, mode, {
    reason,
    phaseId,
    code: decision.code,
    retryContext: decision.retryContext || {},
  });
}

if (isMain) {
  await main().catch(() => silent());
}
