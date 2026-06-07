#!/usr/bin/env node
/**
 * MPL E2E Authenticity Guard (PreToolUse on Write|Edit|MultiEdit targeting state.json).
 *
 * `mpl-require-e2e.mjs` proves required scenarios ran and exited 0. This hook
 * proves the scenarios are admissible evidence for the goal contract: real
 * runtime when required, no mock substitution when mock_allowed=false, and no
 * placeholder assertions when placeholder assertions are forbidden.
 *
 * Policy-SSOT + legacy-layer wrapper (Move #8 Phase B), mirroring the
 * `mpl-require-e2e.mjs` idiom:
 *   1. Preserve the legacy stdin / tool gate / finalize_done detection /
 *      cfg.e2e_authenticity_required=false opt-out / loadOverride gates
 *      verbatim — the existing test fixtures (mpl-require-e2e-authenticity
 *      test) target these byte-for-byte.
 *   2. Call `policy.handleE2eAuthenticity` (hooks/lib/policy/contracts.mjs).
 *      Seed `issues[]` from `decision.retryContext.issues` on action='block'
 *      so the canonical failure_code tokens — `required_e2e_scenario_missing`,
 *      `<id>:runtime_class=missing`, `<id>:mock_allowed=true`, and
 *      `<id>:mock_token_in_command` — propagate from the policy SSOT.
 *   3. Append LOCAL-LAYER predicates the policy doesn't own yet:
 *        - `detectTauriCapabilityIssues` → `tauri_capabilities_missing`
 *        - `scanTestFiles` → `<id>:placeholder_assertion:<rel>`,
 *          `<id>:forbidden_pattern:<pat>:<rel>`, `<id>:fake_runtime_e2e:<rel>`,
 *          `<id>:test_file_missing:<rel>`
 *        - launcher_evidence_missing, assertion_evidence_missing
 *      These local predicates are disjoint from the policy's runtime_class /
 *      mock_* set, so no de-dup is necessary.
 *   4. Rebuild the legacy reason string verbatim (legacy prefix +
 *      `${issues.join(', ')}`) so every test substring regex matches
 *      byte-for-byte: the decision='block' shape AND the canonical token
 *      strings.
 *
 * Named export `parseE2EScenariosText` is preserved — tests import it
 * directly from this hook file.
 *
 * Rollback: `mpl-require-e2e-authenticity.legacy.mjs` sibling is preserved.
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;

const { isMplActive, readState } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);
const { loadConfig } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-config.mjs')).href
);
const { readGoalContract } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-goal-contract.mjs')).href
);
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);
const { emitBlockedHook, emitClearedOk } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-block-surface.mjs')).href
);

// Policy SSOT — seeds runtime_class / mock predicates. Loaded behind a
// try/catch so policy import failure degrades to the local-only layer
// rather than converting allow→error.
let policyHandleE2eAuthenticity = null;
try {
  const mod = await import(
    pathToFileURL(join(__dirname, 'lib', 'policy', 'contracts.mjs')).href
  );
  policyHandleE2eAuthenticity =
    typeof mod?.handleE2eAuthenticity === 'function' ? mod.handleE2eAuthenticity : null;
} catch {
  policyHandleE2eAuthenticity = null;
}

const REAL_RUNTIME_CLASSES = new Set([
  'real_desktop',
  'real_web',
  'real_browser',
  'real_mobile',
  'real_api',
]);

const MOCK_PATTERN = /\b(mock|stub|fake|msw|mockIPC|VITE_E2E_MOCK|__mocks__)\b/i;
const PLACEHOLDER_PATTERN = /\b(expect\s*\(\s*true\s*\)|assert\s*\(\s*true\s*\)|\.toBe\s*\(\s*true\s*\)|test\.skip\s*\(|it\.skip\s*\(|describe\.skip\s*\()/;
const FAKE_RUNTIME_E2E_PATTERN = /\bWITHOUT\s+a\s+running\s+Tauri\s+runtime\b|\bwithout\s+a\s+running\s+Tauri\s+runtime\b|\brepo\/db layer directly\b|\brepo layer directly\b|\bbypass(?:es|ing)?\s+Tauri\s+runtime\b/i;

const HOOK_ID = 'mpl-require-e2e-authenticity';
const BLOCKED_ARTIFACT = '.mpl/state.json#finalize_done';

function ok() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

function normalizeScalar(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'null') return null;
  return trimmed.replace(/^["']|["']$/g, '').trim() || null;
}

function parseInlineList(value) {
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((s) => normalizeScalar(s))
    .filter(Boolean);
}

function targetPaths(toolInput) {
  const paths = [];
  if (toolInput.file_path) paths.push(toolInput.file_path);
  if (toolInput.filePath) paths.push(toolInput.filePath);
  if (Array.isArray(toolInput.edits)) {
    for (const edit of toolInput.edits) {
      if (edit?.file_path) paths.push(edit.file_path);
      if (edit?.filePath) paths.push(edit.filePath);
    }
  }
  return paths;
}

function proposedTexts(toolInput) {
  const texts = [];
  for (const key of ['new_string', 'newString', 'content']) {
    if (typeof toolInput[key] === 'string') texts.push(toolInput[key]);
  }
  if (Array.isArray(toolInput.edits)) {
    for (const edit of toolInput.edits) {
      for (const key of ['new_string', 'newString', 'content']) {
        if (typeof edit?.[key] === 'string') texts.push(edit[key]);
      }
    }
  }
  return texts;
}

function isFinalizeDoneWrite(toolInput) {
  if (!targetPaths(toolInput).some((p) => /\.mpl\/state\.json$/.test(p))) return false;
  // Intentionally re-check any proposed state text that contains
  // finalize_done=true, including state re-serializations after completion:
  // evidence can be deleted or invalidated between final writes.
  return proposedTexts(toolInput).some((text) => /"finalize_done"\s*:\s*true/.test(text));
}

export function parseE2EScenariosText(text) {
  const out = [];
  let cur = null;
  let listField = null;
  let listIndent = -1;

  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const idMatch = line.match(/^\s*-\s+id:\s*["']?(E2E-[\w-]+)["']?/);
    if (idMatch) {
      if (cur) out.push(cur);
      cur = {
        id: idMatch[1],
        required: true,
        test_command: null,
        runtime_class: null,
        mock_allowed: null,
        launcher_evidence: null,
        assertion_evidence: null,
        test_files: [],
        forbidden_patterns: [],
      };
      listField = null;
      continue;
    }
    if (!cur) continue;

    const scalar = line.match(/^\s+([a-zA-Z_][\w-]*)\s*:\s*(.+?)\s*$/);
    if (scalar) {
      const [, key, value] = scalar;
      if (value.startsWith('[') && value.endsWith(']')) {
        cur[key] = parseInlineList(value.slice(1, -1));
        listField = null;
        continue;
      }
      if (key === 'required' || key === 'mock_allowed') {
        const normalized = normalizeScalar(value);
        cur[key] = normalized === 'true' ? true : (normalized === 'false' ? false : null);
        listField = null;
        continue;
      }
      if (key in cur) {
        cur[key] = normalizeScalar(value);
        listField = null;
      }
      continue;
    }

    const listStart = line.match(/^(\s+)(test_files|forbidden_patterns)\s*:\s*$/);
    if (listStart) {
      listIndent = listStart[1].length;
      listField = listStart[2];
      continue;
    }

    if (listField) {
      const item = line.match(/^(\s*)-\s+(.+?)\s*$/);
      if (item && item[1].length > listIndent) {
        cur[listField].push(normalizeScalar(item[2]));
        continue;
      }
      listField = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function loadScenarios(cwd) {
  const path = join(cwd, '.mpl', 'mpl', 'e2e-scenarios.yaml');
  if (!existsSync(path)) return [];
  try {
    return parseE2EScenariosText(readFileSync(path, 'utf-8'));
  } catch {
    return [];
  }
}

function loadOverride(cwd) {
  const path = join(cwd, '.mpl', 'config', 'e2e-authenticity-override.json');
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (typeof parsed?.reason === 'string' && parsed.reason.trim()) return parsed;
  } catch {
    // fall through
  }
  return null;
}

function scanTestFiles(cwd, scenario) {
  const hits = [];
  for (const rel of scenario.test_files || []) {
    const abs = join(cwd, rel);
    if (!existsSync(abs)) {
      hits.push(`${scenario.id}:test_file_missing:${rel}`);
      continue;
    }
    let text;
    try { text = readFileSync(abs, 'utf-8'); } catch { continue; }
    if (PLACEHOLDER_PATTERN.test(text)) hits.push(`${scenario.id}:placeholder_assertion:${rel}`);
    if (
      scenario.runtime_class === 'real_desktop' &&
      FAKE_RUNTIME_E2E_PATTERN.test(text)
    ) {
      hits.push(`${scenario.id}:fake_runtime_e2e:${rel}`);
    }
    for (const pattern of scenario.forbidden_patterns || []) {
      if (pattern && text.includes(pattern)) hits.push(`${scenario.id}:forbidden_pattern:${pattern}:${rel}`);
    }
  }
  return hits;
}

function walkFiles(root, opts = {}) {
  const limit = opts.limit ?? 1000;
  const out = [];
  const stack = [root];
  while (stack.length > 0 && out.length < limit) {
    const dir = stack.pop();
    let entries = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === 'target' || entry === '.git') continue;
      const abs = join(dir, entry);
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (st.isFile()) out.push(abs);
      if (out.length >= limit) break;
    }
  }
  return out;
}

function anyFileMatches(root, pattern) {
  if (!existsSync(root)) return false;
  for (const file of walkFiles(root)) {
    let text;
    try { text = readFileSync(file, 'utf-8'); } catch { continue; }
    if (pattern.test(text)) return true;
  }
  return false;
}

function hasCapabilityJson(cwd) {
  const dir = join(cwd, 'src-tauri', 'capabilities');
  if (!existsSync(dir)) return false;
  return walkFiles(dir, { limit: 100 }).some((file) => /\.json$/i.test(file));
}

function detectTauriCapabilityIssues(cwd) {
  const conf = join(cwd, 'src-tauri', 'tauri.conf.json');
  if (!existsSync(conf)) return [];

  const frontendInvokes = anyFileMatches(join(cwd, 'src'), /\binvoke\s*\(|@tauri-apps\/api\/core/);
  const rustCommands = anyFileMatches(join(cwd, 'src-tauri', 'src'), /#\s*\[\s*tauri::command\s*\]/);
  if (!frontendInvokes && !rustCommands) return [];

  if (!hasCapabilityJson(cwd)) return ['tauri_capabilities_missing'];
  return [];
}

// Local-layer authenticity checks that the policy SSOT does NOT own.
// These are disjoint from policy's runtime_class / mock_* set, with one
// intentional overlap: `required_e2e_scenario_missing`. The policy emits
// this only when the YAML file EXISTS but contains zero required
// scenarios; the legacy hook (and exp19 regression test) also expect it
// when the YAML file is absent. Local owns the broader predicate and
// dedupe is handled by the caller.
function localAuthenticityIssues(cwd, scenarios, policy) {
  const issues = [];
  if (policy.real_runtime_required !== false) {
    issues.push(...detectTauriCapabilityIssues(cwd));
  }

  const required = scenarios.filter((s) => s.required !== false && s.test_command);
  if (policy.real_runtime_required !== false && required.length === 0) {
    // Covers both "YAML missing" and "YAML present but no required
    // scenarios" — superset of the policy's predicate so we can dedupe
    // safely.
    issues.push('required_e2e_scenario_missing');
  }

  for (const scenario of required) {
    if (policy.real_runtime_required !== false && !scenario.launcher_evidence) {
      issues.push(`${scenario.id}:launcher_evidence_missing`);
    }
    if (policy.placeholder_assertions_allowed === false) {
      if (!scenario.assertion_evidence && (!scenario.test_files || scenario.test_files.length === 0)) {
        issues.push(`${scenario.id}:assertion_evidence_missing`);
      }
      issues.push(...scanTestFiles(cwd, scenario));
    }
  }
  return issues;
}

async function main() {
  const raw = await readStdin();
  if (!raw.trim()) return ok();

  let data;
  try { data = JSON.parse(raw); } catch { return ok(); }

  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) return ok();

  const toolName = String(data.tool_name || data.toolName || '');
  if (!['Write', 'write', 'Edit', 'edit', 'MultiEdit', 'multiEdit'].includes(toolName)) return ok();

  const toolInput = data.tool_input || data.toolInput || {};
  if (!isFinalizeDoneWrite(toolInput)) return ok();

  const cfg = loadConfig(cwd);
  if (cfg.e2e_authenticity_required === false) {
    // Codex r1 on PR #246: explicit config opt-out clears stale envelope.
    emitClearedOk(cwd, { hookId: HOOK_ID, artifact: BLOCKED_ARTIFACT });
    return;
  }
  if (loadOverride(cwd)) {
    emitClearedOk(cwd, { hookId: HOOK_ID, artifact: BLOCKED_ARTIFACT });
    return;
  }

  const goal = readGoalContract(cwd);
  const policy = goal.valid
    ? goal.contract.e2e_policy
    : {
        real_runtime_required: true,
        mock_allowed: false,
        placeholder_assertions_allowed: false,
      };

  const state = readState(cwd) || {};
  const scenarios = loadScenarios(cwd);

  // ---------------------------------------------------------------
  // 1. Policy SSOT — runtime_class / mock_allowed / mock_token /
  //    required_e2e_scenario_missing.
  //    Failure inside the policy must NOT convert allow→error; degrade
  //    gracefully to the local-only layer.
  // ---------------------------------------------------------------
  const issues = [];
  if (policyHandleE2eAuthenticity) {
    try {
      const decision = policyHandleE2eAuthenticity({
        cwd,
        toolInput,
        config: cfg,
        state,
        toolName,
        hookEvent: data.hook_event_name || 'PreToolUse',
      });
      if (decision && decision.action === 'block') {
        const policyIssues = Array.isArray(decision.retryContext?.issues)
          ? decision.retryContext.issues
          : [];
        issues.push(...policyIssues);
      }
    } catch {
      // Degrade silently — local layer below is the safety net.
    }
  }

  // ---------------------------------------------------------------
  // 2. Local layer — placeholder/tauri/launcher/assertion checks the
  //    policy does not (yet) own. `required_e2e_scenario_missing`
  //    overlaps with the policy (which only fires when the YAML file
  //    exists), so we dedupe after concatenation while preserving
  //    insertion order — first occurrence wins, every test substring
  //    regex still matches.
  // ---------------------------------------------------------------
  issues.push(...localAuthenticityIssues(cwd, scenarios, policy));

  const deduped = [];
  const seen = new Set();
  for (const issue of issues) {
    if (seen.has(issue)) continue;
    seen.add(issue);
    deduped.push(issue);
  }
  const finalIssues = deduped;

  if (finalIssues.length === 0) {
    emitClearedOk(cwd, { hookId: HOOK_ID, artifact: BLOCKED_ARTIFACT });
    return;
  }

  // Reason rebuilt with the legacy prefix verbatim so every test
  // regex substring (`required_e2e_scenario_missing`,
  // `runtime_class=missing`, `mock_token_in_command`,
  // `placeholder_assertion`, `tauri_capabilities_missing`) matches
  // byte-for-byte.
  emitBlockedHook(cwd, state, {
    hookId: HOOK_ID,
    ruleId: 'e2e_authenticity_invalid',
    code: 'e2e_authenticity_invalid',
    artifact: BLOCKED_ARTIFACT,
    reason:
      `[MPL E2E Authenticity] Cannot set finalize_done=true — required E2E evidence is not authentic: ${finalIssues.join(', ')}. ` +
      'Use real runtime scenarios, remove mock/placeholder substitutes, or record a user-approved override in .mpl/config/e2e-authenticity-override.json.',
    resumeInstruction:
      'Replace mock/placeholder E2E substitutes with authentic real-runtime scenarios (or record a user-approved override), then retry finalize.',
    retryContext: { issues: finalIssues.slice(0, 50) },
  });
}

if (isMain) {
  await main().catch(() => ok());
}
