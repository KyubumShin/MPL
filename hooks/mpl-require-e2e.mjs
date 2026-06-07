#!/usr/bin/env node
/**
 * MPL Require E2E Hook (PreToolUse on Write|Edit|MultiEdit targeting state.json)
 *
 * Thin wrapper over `hooks/lib/policy/contracts.mjs::handleE2eGate` (aliased
 * here as `handleE2E`). The policy module is the SSOT for the post-finalize
 * structural decision:
 *   - required scenarios with missing test_command
 *   - declared required scenarios never executed / non-zero exit
 *
 * The legacy hook ALSO enforced two predicates the policy does not own yet:
 *   1. AD-0008 "zero declared scenarios" guard when the goal contract sets
 *      e2e_policy.real_runtime_required: true (exp19 regression),
 *   2. 0.16 Tier C UC-coverage gate against user-contract.md.
 * Those two checks are layered locally so the legacy stdout contract is
 * preserved end-to-end. Both rely on `parseUserContractText` and
 * `computeUncoveredUcs`, which remain exported for the unit tests.
 *
 * Legacy stdout contract preserved:
 *   allow → {continue:true, suppressOutput:true}
 *   block → {continue:false, decision:'block', reason}
 *   warn  → {continue:true, suppressOutput:false, systemMessage:...}
 *   block path also records the blocked_hook envelope via emitBlockedHook,
 *   warn / clear paths invoke clearBlockedHook to drop a stale envelope.
 *
 * Original implementation: hooks/mpl-require-e2e.legacy.mjs
 *
 * Non-blocking on error: every exception → ok().
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
const { readGoalContract } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-goal-contract.mjs')).href
);
const { loadConfig } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-config.mjs')).href
);
const { readStdin } = isMain
  ? await import(pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href)
  : { readStdin: async () => '' };
const { emitBlockedHook, emitClearedOk } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-block-surface.mjs')).href
);
const { clearBlockedHook } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-blocked-hook.mjs')).href
);
const { handleE2eGate: handleE2E } = await import(
  pathToFileURL(join(__dirname, 'lib', 'policy', 'contracts.mjs')).href
);

const HOOK_ID = 'mpl-require-e2e';
const BLOCKED_ARTIFACT = '.mpl/state.json#finalize_done';

function ok() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

function blockE2E(cwd, state, { code, reason, resumeInstruction, retryContext = {} }) {
  emitBlockedHook(cwd, state, {
    hookId: HOOK_ID,
    ruleId: 'missing_e2e_evidence',
    code,
    artifact: BLOCKED_ARTIFACT,
    reason,
    resumeInstruction,
    retryContext,
  });
}

// ---------------------------------------------------------------------------
// Named exports preserved for the existing unit-test surface.
// (The parsers stay local; the policy module owns the structural allow/block
// decision but tests import these helpers directly.)
// ---------------------------------------------------------------------------

export function isE2EContractStrict(cwd) {
  try {
    const cfgPath = join(cwd, '.mpl', 'config.json');
    if (!existsSync(cfgPath)) return true;
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    if (cfg && cfg.e2e_contract_strict === false) return false;
  } catch { /* fall through */ }
  return true;
}

export function parseUserContract(cwd) {
  const path = join(cwd, '.mpl', 'requirements', 'user-contract.md');
  if (!existsSync(path)) return { included_uc_ids: [], scenarios: [] };
  let text;
  try { text = readFileSync(path, 'utf-8'); }
  catch { return { included_uc_ids: [], scenarios: [] }; }
  return parseUserContractText(text);
}

export function parseUserContractText(text) {
  if (!text || typeof text !== 'string') return { included_uc_ids: [], scenarios: [] };
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  let section = null;
  const included = [];
  const scenarios = [];
  let curScenario = null;
  let inListField = null;
  let listIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const topMatch = line.match(/^(user_cases|deferred_cases|cut_cases|scenarios)\s*:\s*$/);
    if (topMatch) {
      if (curScenario) scenarios.push(curScenario);
      curScenario = null;
      section = topMatch[1];
      inListField = null;
      continue;
    }
    if (/^[a-zA-Z_]/.test(line) && !line.startsWith(' ')) {
      if (curScenario) scenarios.push(curScenario);
      curScenario = null;
      section = null;
      inListField = null;
      continue;
    }
    if (section === 'user_cases') {
      const idMatch = line.match(/^\s*-\s+id:\s*["']?(UC-\d{2,})["']?/);
      if (idMatch) { included.push({ id: idMatch[1], status: 'included' }); continue; }
      const statusMatch = line.match(/^\s+status:\s*["']?(included|deferred|cut)["']?/);
      if (statusMatch && included.length > 0) {
        included[included.length - 1].status = statusMatch[1];
        continue;
      }
    }
    if (section === 'scenarios') {
      const idMatch = line.match(/^\s*-\s+id:\s*["']?(SC-[\w-]+|E2E-[\w-]+)["']?/);
      if (idMatch) {
        if (curScenario) scenarios.push(curScenario);
        curScenario = { id: idMatch[1], covers: [], skip_allowed: [] };
        inListField = null;
        continue;
      }
      if (!curScenario) continue;
      const inlineCovers = line.match(/^\s+covers\s*:\s*\[(.*)\]\s*$/);
      if (inlineCovers) {
        curScenario.covers = inlineCovers[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
        inListField = null;
        continue;
      }
      const inlineSkip = line.match(/^\s+skip_allowed\s*:\s*\[(.*)\]\s*$/);
      if (inlineSkip) {
        curScenario.skip_allowed = inlineSkip[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
        inListField = null;
        continue;
      }
      const blockCovers = line.match(/^(\s+)covers\s*:\s*$/);
      if (blockCovers) { inListField = 'covers'; listIndent = blockCovers[1].length; continue; }
      const blockSkip = line.match(/^(\s+)skip_allowed\s*:\s*$/);
      if (blockSkip) { inListField = 'skip_allowed'; listIndent = blockSkip[1].length; continue; }
      if (inListField) {
        const itemMatch = line.match(/^(\s*)-\s+["']?([^"'\s#]+)["']?/);
        if (itemMatch && itemMatch[1].length > listIndent) {
          curScenario[inListField].push(itemMatch[2]);
          continue;
        }
        inListField = null;
      }
    }
  }
  if (curScenario) scenarios.push(curScenario);
  return {
    included_uc_ids: included.filter((u) => u.status === 'included').map((u) => u.id),
    scenarios,
  };
}

export function computeUncoveredUcs(includedUcIds, scenarios) {
  const covered = new Set();
  for (const s of scenarios) for (const uc of s.covers || []) covered.add(uc);
  return includedUcIds.filter((id) => !covered.has(id));
}

function realRuntimeE2ERequired(cwd) {
  const goal = readGoalContract(cwd);
  return goal.valid && goal.contract.e2e_policy.real_runtime_required === true;
}

function isFinalizeDoneWrite(toolInput) {
  const paths = [];
  if (toolInput.file_path) paths.push(toolInput.file_path);
  if (toolInput.filePath) paths.push(toolInput.filePath);
  const texts = [];
  for (const key of ['new_string', 'newString', 'content']) {
    if (typeof toolInput[key] === 'string') texts.push(toolInput[key]);
  }
  if (Array.isArray(toolInput.edits)) {
    for (const edit of toolInput.edits) {
      if (edit?.file_path) paths.push(edit.file_path);
      if (edit?.filePath) paths.push(edit.filePath);
      for (const key of ['new_string', 'newString', 'content']) {
        if (typeof edit?.[key] === 'string') texts.push(edit[key]);
      }
    }
  }
  if (!paths.some((p) => /\.mpl\/state\.json$/.test(p))) return false;
  return texts.some((text) => /"finalize_done"\s*:\s*true/.test(text));
}

// ---------------------------------------------------------------------------
// Delegating hook entrypoint.
// ---------------------------------------------------------------------------

async function runHook() {
  const raw = await readStdin();
  if (!raw.trim()) { ok(); return; }
  let data;
  try { data = JSON.parse(raw); } catch { ok(); return; }

  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) { ok(); return; }

  const toolName = String(data.tool_name || data.toolName || '');
  if (!['Write', 'write', 'Edit', 'edit', 'MultiEdit', 'multiEdit'].includes(toolName)) {
    ok(); return;
  }

  const toolInput = data.tool_input || data.toolInput || {};
  if (!isFinalizeDoneWrite(toolInput)) { ok(); return; }

  const state = readState(cwd) || {};
  const config = loadConfig(cwd);
  const event = data.hook_event_name || 'PreToolUse';

  // --- Structural decision (policy SSOT) -----------------------------------
  const decision = await handleE2E({
    cwd, toolName, toolInput, state, config, hookEvent: event,
  });

  if (decision && decision.action === 'block') {
    // Translate policy envelope → legacy stdout shape, re-decorating the
    // reason / resumeInstruction with the richer AD-0008 text the orchestrator
    // and recover skill rely on.
    if (decision.code === 'e2e_test_command_missing') {
      const ids = decision.retryContext?.missing_command || [];
      blockE2E(cwd, state, {
        code: 'e2e_test_command_missing',
        reason:
          `[MPL AD-0008] Cannot set finalize_done=true — required E2E scenario(s) missing executable test_command: ${ids.join(', ')}. ` +
          `Re-run decomposition Step 3-H and emit executable commands, or mark the scenario required:false with a rationale.`,
        resumeInstruction:
          'Re-run decomposition Step 3-H to emit executable test_command for every required E2E scenario, then retry finalize.',
        retryContext: { missing_command: ids },
      });
      return;
    }
    if (decision.code === 'e2e_scenarios_unresolved') {
      const unresolved = decision.retryContext?.unresolved || [];
      blockE2E(cwd, state, {
        code: 'e2e_scenarios_unresolved',
        reason:
          `[MPL AD-0008] Cannot set finalize_done=true — ${unresolved.length} required E2E scenario(s) missing or failing: ${unresolved.join(', ')}. ` +
          `Each required scenario's test_command must be executed (gate-recorder writes state.e2e_results automatically) AND exit 0, ` +
          `OR explicitly overridden via .mpl/config/e2e-scenario-override.json with a user reason. ` +
          `Re-run the scenarios or use /mpl:mpl-finalize Step 5.0 HITL to record overrides before retrying finalize.`,
        resumeInstruction:
          'Re-execute each unresolved E2E scenario (or record an override in .mpl/config/e2e-scenario-override.json), then retry finalize.',
        retryContext: { unresolved },
      });
      return;
    }
    // Generic fallback — surface the policy's reason as-is.
    blockE2E(cwd, state, {
      code: decision.code || 'e2e_blocked',
      reason: decision.reason || '[MPL AD-0008] E2E gate blocked finalize.',
      resumeInstruction: decision.resumeInstruction || 'Resolve the E2E gate violation, then retry finalize.',
      retryContext: decision.retryContext || {},
    });
    return;
  }

  // --- Legacy-only predicates the policy does NOT cover --------------------
  // The policy only inspects e2e-scenarios.yaml; the legacy hook ALSO blocks
  // when the goal contract demands real-runtime E2E or when included UCs
  // lack scenario coverage, even with no declared scenarios.
  const contract = parseUserContract(cwd);
  const scenariosFilePath = join(cwd, '.mpl', 'mpl', 'e2e-scenarios.yaml');
  const haveScenarios = existsSync(scenariosFilePath);

  if (!haveScenarios) {
    const reasons = [];
    if (realRuntimeE2ERequired(cwd)) reasons.push('goal contract requires real runtime E2E');
    if (contract.included_uc_ids.length > 0) {
      reasons.push(`${contract.included_uc_ids.length} included UC(s) have no executable E2E scenario`);
    }
    if (reasons.length > 0) {
      const message =
        `[MPL AD-0008] Cannot set finalize_done=true — ${reasons.join('; ')}. ` +
        `Emit .mpl/mpl/e2e-scenarios.yaml with at least one required scenario and executable test_command, run it, and let gate-recorder populate state.e2e_results.`;
      if (realRuntimeE2ERequired(cwd) || isE2EContractStrict(cwd)) {
        blockE2E(cwd, state, {
          code: 'e2e_required_scenarios_absent',
          reason: message,
          resumeInstruction:
            'Emit at least one required E2E scenario with executable test_command in .mpl/mpl/e2e-scenarios.yaml, execute it, then retry finalize.',
          retryContext: { reasons },
        });
        return;
      }
      // warn downgrade — clear any stale envelope so mpl-recover doesn't
      // dispatch on a no-longer-applicable block (Codex r3 on PR #246).
      clearBlockedHook(cwd, { hookId: HOOK_ID, artifact: BLOCKED_ARTIFACT });
      console.log(JSON.stringify({
        continue: true,
        suppressOutput: false,
        systemMessage: `[MPL AD-0008 WARN] ${message}`,
      }));
      return;
    }
  }

  // UC coverage gate (0.16 Tier C) — applies even when scenarios exist.
  if (contract.included_uc_ids.length > 0) {
    const uncovered = computeUncoveredUcs(contract.included_uc_ids, contract.scenarios);
    if (uncovered.length > 0) {
      if (isE2EContractStrict(cwd)) {
        blockE2E(cwd, state, {
          code: 'e2e_uc_coverage_missing',
          reason:
            `[MPL 0.16 Tier C] Cannot set finalize_done=true — ${uncovered.length} included UC(s) have no E2E scenario coverage: ${uncovered.join(', ')}. ` +
            `Add scenarios to .mpl/requirements/user-contract.md (each scenario's covers[] must list the UC) ` +
            `or opt out of strict mode via .mpl/config.json { "e2e_contract_strict": false }.`,
          resumeInstruction:
            "Add E2E scenarios that cover each uncovered UC (each scenario's covers[] must list the UC), or opt out of strict mode, then retry finalize.",
          retryContext: { uncovered_ucs: uncovered },
        });
        return;
      }
      clearBlockedHook(cwd, { hookId: HOOK_ID, artifact: BLOCKED_ARTIFACT });
      console.log(JSON.stringify({
        continue: true,
        suppressOutput: false,
        systemMessage:
          `[MPL 0.16 Tier C WARN] ${uncovered.length} UC(s) without E2E scenario coverage: ${uncovered.join(', ')}. ` +
          `Strict mode is disabled; add coverage or re-enable e2e_contract_strict=true before the next run.`,
      }));
      return;
    }
  }

  // All gates clear: drop any stale envelope and emit the silent success.
  emitClearedOk(cwd, { hookId: HOOK_ID, artifact: BLOCKED_ARTIFACT });
}

if (isMain) {
  runHook().catch(() => { ok(); });
}
