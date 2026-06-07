#!/usr/bin/env node
/**
 * MPL Require E2E Hook (PreToolUse on Write|Edit|MultiEdit targeting state.json)
 *
 * Guards the transition to `finalize_done: true`. Reads the declared required
 * E2E scenarios from `.mpl/mpl/e2e-scenarios.yaml` and blocks the state write
 * if any required scenario has not been recorded as passing in
 * `state.e2e_results` AND is not overridden.
 *
 * AD-0008 enforcement contract:
 *   - Finalize Step 5.0 is responsible for executing missing scenarios
 *     (via Bash) before setting finalize_done. The gate-recorder hook writes
 *     `state.e2e_results[scenario.id]` as each execution completes.
 *   - This hook is the last line of defence: if finalize is asked to mark the
 *     pipeline complete while any required scenario lacks a passing exit code,
 *     the hook emits {continue: false, decision: "block", reason: ...}.
 *   - Override: `.mpl/config/e2e-scenario-override.json` can bypass with a
 *     user-supplied reason (AD-0007 pattern, extended with environment marker
 *     per AD-0008 R-2).
 *
 * The hook deliberately does NOT attempt to parse arbitrary Edit new_string
 * JSON — instead it reads the CURRENT state.json from disk after the write
 * would have happened (effectively an after-the-fact check). Because a
 * PreToolUse hook fires BEFORE the tool runs, we inspect the tool input
 * directly when it's a JSON assignment the caller can reveal.
 *
 * Non-blocking on error: swallows every exception.
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
const { readStdin } = isMain
  ? await import(pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href)
  : { readStdin: async () => '' };
const { emitBlockedHook, emitClearedOk } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-block-surface.mjs')).href
);
const { clearBlockedHook } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-blocked-hook.mjs')).href
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

/**
 * Parse e2e-scenarios.yaml minimal subset for required entries.
 * Returns array of { id, title, test_command, required } in declaration order.
 */
function parseScenarios(cwd) {
  const path = join(cwd, '.mpl', 'mpl', 'e2e-scenarios.yaml');
  if (!existsSync(path)) return [];

  let text;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }

  const out = [];
  let cur = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');

    const idMatch = line.match(/^\s*-\s+id:\s*["']?(E2E-[\w-]+)["']?/);
    if (idMatch) {
      if (cur) out.push(cur);
      cur = {
        id: idMatch[1],
        title: null,
        test_command: null,
        required: true, // default
      };
      continue;
    }
    if (!cur) continue;

    const titleMatch = line.match(/^\s+title:\s*["']?(.+?)["']?\s*$/);
    if (titleMatch) {
      cur.title = titleMatch[1];
      continue;
    }

    const tcMatch = line.match(/^\s+test_command:\s*["']?(.+?)["']?\s*$/);
    if (tcMatch) {
      cur.test_command = tcMatch[1];
      continue;
    }

    const reqMatch = line.match(/^\s+required:\s*(true|false)\s*$/i);
    if (reqMatch) {
      cur.required = reqMatch[1].toLowerCase() === 'true';
      continue;
    }
  }
  if (cur) out.push(cur);

  return out;
}

/**
 * AD-0008 R-2: overrides may be a string (legacy shape from AD-0007) or an
 * object with { reason, test_command_hash, recorded_at, source }. Returns the
 * unified shape or null.
 */
function loadOverride(cwd) {
  const path = join(cwd, '.mpl', 'config', 'e2e-scenario-override.json');
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * 0.16 Tier C: read .mpl/config.json { e2e_contract_strict: false } to
 * degrade the missing-UC-coverage check from block to warn. Default true (strict).
 */
export function isE2EContractStrict(cwd) {
  try {
    const cfgPath = join(cwd, '.mpl', 'config.json');
    if (!existsSync(cfgPath)) return true;
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    if (cfg && cfg.e2e_contract_strict === false) return false;
  } catch {
    // fall through
  }
  return true;
}

/**
 * 0.16 Tier A'/C: parse .mpl/requirements/user-contract.md to extract the
 * included UC ids and the scenario→UC mapping. File is YAML-shaped even though
 * it carries an .md extension (pragmatic convention — see Plan v2 Q5).
 *
 * Returns { included_uc_ids: [string], scenarios: [{id, covers, skip_allowed}] }.
 * Missing file → empty result (graceful skip mode).
 */
export function parseUserContract(cwd) {
  const path = join(cwd, '.mpl', 'requirements', 'user-contract.md');
  if (!existsSync(path)) return { included_uc_ids: [], scenarios: [] };

  let text;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return { included_uc_ids: [], scenarios: [] };
  }

  return parseUserContractText(text);
}

export function parseUserContractText(text) {
  if (!text || typeof text !== 'string') return { included_uc_ids: [], scenarios: [] };

  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));

  let section = null; // "user_cases" | "scenarios" | null
  let sectionIndent = -1;
  const included = [];
  const scenarios = [];
  let curScenario = null;
  let inListField = null; // "covers" | "skip_allowed"
  let listIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;

    // Top-level section detection
    const topMatch = line.match(/^(user_cases|deferred_cases|cut_cases|scenarios)\s*:\s*$/);
    if (topMatch) {
      if (curScenario) scenarios.push(curScenario);
      curScenario = null;
      section = topMatch[1];
      sectionIndent = 0;
      inListField = null;
      continue;
    }

    // Top-level unrelated keys terminate the section
    if (/^[a-zA-Z_]/.test(line) && !line.startsWith(' ')) {
      if (curScenario) scenarios.push(curScenario);
      curScenario = null;
      section = null;
      inListField = null;
      continue;
    }

    if (section === 'user_cases') {
      const idMatch = line.match(/^\s*-\s+id:\s*["']?(UC-\d{2,})["']?/);
      if (idMatch) {
        // Peek forward for status: "included"; safer to accept-all-then-filter via default
        // We stream-parse: assume status defaults to "included" unless explicitly set.
        included.push({ id: idMatch[1], status: 'included' });
        continue;
      }
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

      // Inline arrays
      const inlineCovers = line.match(/^\s+covers\s*:\s*\[(.*)\]\s*$/);
      if (inlineCovers) {
        curScenario.covers = inlineCovers[1]
          .split(',')
          .map((s) => s.trim().replace(/^["']|["']$/g, ''))
          .filter(Boolean);
        inListField = null;
        continue;
      }
      const inlineSkip = line.match(/^\s+skip_allowed\s*:\s*\[(.*)\]\s*$/);
      if (inlineSkip) {
        curScenario.skip_allowed = inlineSkip[1]
          .split(',')
          .map((s) => s.trim().replace(/^["']|["']$/g, ''))
          .filter(Boolean);
        inListField = null;
        continue;
      }

      // Block list form
      const blockCovers = line.match(/^(\s+)covers\s*:\s*$/);
      if (blockCovers) {
        inListField = 'covers';
        listIndent = blockCovers[1].length;
        continue;
      }
      const blockSkip = line.match(/^(\s+)skip_allowed\s*:\s*$/);
      if (blockSkip) {
        inListField = 'skip_allowed';
        listIndent = blockSkip[1].length;
        continue;
      }

      if (inListField) {
        const itemMatch = line.match(/^(\s*)-\s+["']?([^"'\s#]+)["']?/);
        if (itemMatch && itemMatch[1].length > listIndent) {
          curScenario[inListField].push(itemMatch[2]);
          continue;
        }
        // leaving list
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

/**
 * 0.16 Tier C: compute which `included` UCs have no scenario covering them.
 * Returns array of uncovered UC ids.
 */
export function computeUncoveredUcs(includedUcIds, scenarios) {
  const covered = new Set();
  for (const s of scenarios) {
    for (const uc of s.covers || []) covered.add(uc);
  }
  return includedUcIds.filter((id) => !covered.has(id));
}

function realRuntimeE2ERequired(cwd) {
  const goal = readGoalContract(cwd);
  return goal.valid && goal.contract.e2e_policy.real_runtime_required === true;
}

/**
 * Detect whether the incoming tool input writes `finalize_done: true` to
 * `.mpl/state.json`. Handles Edit (old_string/new_string) and Write (content).
 * False positives are acceptable — the hook only blocks when scenarios are
 * actually missing, so innocent state edits pass through.
 */
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
  // Match "finalize_done": true in either quoted-JSON or unquoted source.
  // Re-serialized writes are intentionally rechecked because E2E evidence can
  // be deleted or invalidated between final state writes.
  return texts.some((text) => /"finalize_done"\s*:\s*true/.test(text));
}

async function runHook() {
  const raw = await readStdin();
  if (!raw.trim()) {
    ok();
    return;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    ok();
    return;
  }

  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) {
    ok();
    return;
  }

  const toolName = String(data.tool_name || data.toolName || '');
  if (!['Write', 'write', 'Edit', 'edit', 'MultiEdit', 'multiEdit'].includes(toolName)) {
    ok();
    return;
  }

  const toolInput = data.tool_input || data.toolInput || {};
  if (!isFinalizeDoneWrite(toolInput)) {
    ok();
    return;
  }

  // A finalize_done: true write is imminent. Validate E2E coverage.
  const scenarios = parseScenarios(cwd);
  const declaredRequired = scenarios.filter((s) => s.required !== false);
  const missingCommand = declaredRequired.filter((s) => !s.test_command).map((s) => s.id);
  if (missingCommand.length > 0) {
    const state = readState(cwd) || {};
    blockE2E(cwd, state, {
      code: 'e2e_test_command_missing',
      reason:
        `[MPL AD-0008] Cannot set finalize_done=true — required E2E scenario(s) missing executable test_command: ${missingCommand.join(', ')}. ` +
        `Re-run decomposition Step 3-H and emit executable commands, or mark the scenario required:false with a rationale.`,
      resumeInstruction:
        'Re-run decomposition Step 3-H to emit executable test_command for every required E2E scenario, then retry finalize.',
      retryContext: { missing_command: missingCommand },
    });
    return;
  }

  const required = declaredRequired.filter((s) => s.test_command);
  const contract = parseUserContract(cwd);

  if (required.length === 0) {
    const reasons = [];
    if (realRuntimeE2ERequired(cwd)) {
      reasons.push('goal contract requires real runtime E2E');
    }
    if (contract.included_uc_ids.length > 0) {
      reasons.push(`${contract.included_uc_ids.length} included UC(s) have no executable E2E scenario`);
    }

    if (reasons.length > 0) {
      const message =
        `[MPL AD-0008] Cannot set finalize_done=true — ${reasons.join('; ')}. ` +
        `Emit .mpl/mpl/e2e-scenarios.yaml with at least one required scenario and executable test_command, run it, and let gate-recorder populate state.e2e_results.`;
      if (realRuntimeE2ERequired(cwd) || isE2EContractStrict(cwd)) {
        const state = readState(cwd) || {};
        blockE2E(cwd, state, {
          code: 'e2e_required_scenarios_absent',
          reason: message,
          resumeInstruction:
            'Emit at least one required E2E scenario with executable test_command in .mpl/mpl/e2e-scenarios.yaml, execute it, then retry finalize.',
          retryContext: { reasons },
        });
        return;
      }
      // Codex r3 on PR #246: warn downgrade also clears any stale
      // envelope so mpl-recover doesn't dispatch on a no-longer-applicable
      // block.
      clearBlockedHook(cwd, { hookId: HOOK_ID, artifact: BLOCKED_ARTIFACT });
      console.log(JSON.stringify({
        continue: true,
        suppressOutput: false,
        systemMessage: `[MPL AD-0008 WARN] ${message}`,
      }));
      return;
    }

    emitClearedOk(cwd, { hookId: HOOK_ID, artifact: BLOCKED_ARTIFACT });
    return;
  }

  const state = readState(cwd) || {};
  const results = state.e2e_results || {};
  const override = loadOverride(cwd);

  const unresolved = [];
  for (const s of required) {
    // Override check (both legacy string and AD-0008 object shape)
    const entry = override[s.id] ?? override['*'];
    if (entry) {
      if (typeof entry === 'string' && entry.trim().length > 0) continue;
      if (
        typeof entry === 'object' &&
        entry !== null &&
        typeof entry.reason === 'string' &&
        entry.reason.trim().length > 0
      ) {
        // If test_command_hash recorded, check whether scenario changed.
        // We don't compute sha1 inline (keep hook zero-dep); absence of hash
        // match means we trust the override (legacy/unmigrated entry).
        continue;
      }
    }

    const rec = results[s.id];
    if (!rec) {
      unresolved.push(`${s.id} (never executed)`);
      continue;
    }
    if (rec.exit_code !== 0) {
      unresolved.push(`${s.id} (exit ${rec.exit_code})`);
      continue;
    }
  }

  if (unresolved.length > 0) {
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

  // 0.16 Tier C: UC coverage gate.
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
      // Codex r3 on PR #246: warn downgrade clears any stale envelope.
      clearBlockedHook(cwd, { hookId: HOOK_ID, artifact: BLOCKED_ARTIFACT });
      console.log(
        JSON.stringify({
          continue: true,
          suppressOutput: false,
          systemMessage:
            `[MPL 0.16 Tier C WARN] ${uncovered.length} UC(s) without E2E scenario coverage: ${uncovered.join(', ')}. ` +
            `Strict mode is disabled; add coverage or re-enable e2e_contract_strict=true before the next run.`,
        }),
      );
      return;
    }
  }

  // Codex r3 on PR #246: final success path also clears stale envelope.
  emitClearedOk(cwd, { hookId: HOOK_ID, artifact: BLOCKED_ARTIFACT });
}

if (isMain) {
  runHook().catch(() => {
    // Hook must never wedge the pipeline.
    ok();
  });
}
