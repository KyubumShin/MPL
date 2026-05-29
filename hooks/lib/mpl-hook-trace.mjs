#!/usr/bin/env node
import { existsSync, readFileSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import { missingBlockedHookFields } from './mpl-blocked-hook.mjs';
import { CURRENT_SCHEMA_VERSION } from './mpl-state.mjs';

// Read .mpl/state.json byte-for-byte without invoking readState() — that
// helper persists schema migrations and can archive/remove the legacy
// `.mpl/mpl/state.json`. A diagnostic command must never mutate run state
// just by being run; codex r1 on PR #216 flagged this as a state-forensics
// hazard. Return value: either { state } when the parsed object passes
// minimal shape/version checks, { error: 'unparseable' } / { error:
// 'unsupported_schema', schemaVersion } when not, or null when no file
// exists. Codex r6: a future schema_version must fail closed rather than
// being treated as a valid block envelope and pointing recovery at the
// wrong artifact.
function readStateRaw(cwd) {
  const path = join(cwd, '.mpl', 'state.json');
  if (!existsSync(path)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return { error: 'unparseable' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'unparseable' };
  }
  const sv = parsed.schema_version;
  if (typeof sv === 'number' && sv > CURRENT_SCHEMA_VERSION) {
    return { error: 'unsupported_schema', schemaVersion: sv };
  }
  return { state: parsed };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_PLUGIN_ROOT = resolve(__dirname, '..', '..');

const PURPOSES = {
  'mpl-auto-permit': 'learned safe permission preflight',
  'mpl-write-guard': 'direct write/delegation guard',
  'mpl-bash-timeout': 'bash timeout enforcement',
  'mpl-state-invariant': 'state schema and lifecycle invariants',
  'mpl-require-e2e': 'required E2E artifact guard',
  'mpl-require-e2e-authenticity': 'E2E authenticity guard',
  'mpl-require-finalize-artifacts': 'finalization artifact guard',
  'mpl-require-whole-goal-closure': 'whole-goal closure guard',
  'mpl-validate-pp-schema': 'PP schema validation',
  'mpl-require-covers': 'phase coverage guard',
  'mpl-require-goal-trace': 'goal_contract_hash and goal-trace drift check',
  'mpl-require-phase-contract-graph': 'decomposition graph/schema validation',
  'mpl-require-decomposition-delta': 'controlled decomposition delta guard',
  'mpl-require-completed-phase-immutability': 'completed phase immutability guard',
  'mpl-require-phase-evidence': 'phase evidence guard',
  'mpl-baseline-guard': 'baseline immutability/hash guard',
  'mpl-ambiguity-gate': 'ambiguity score gate before decomposer dispatch',
  'mpl-require-chain-assignment': 'chain assignment guard before seed generation',
  'mpl-tool-tracker': 'last-tool telemetry',
  'mpl-gate-recorder': 'gate/test-agent evidence recorder',
  'mpl-fallback-grep': 'anti-pattern fallback scanner',
  'mpl-artifact-schema': 'canonical artifact schema validation',
  'mpl-decomposition-postprocess': 'decomposition normalization/postprocess',
  'mpl-require-test-agent': 'independent test-agent continuation gate',
  'mpl-quality-gate': 'adversarial quality gate',
  'mpl-validate-output': 'agent output validation/token tracking',
  'mpl-validate-seed': 'phase seed validation',
  'mpl-sentinel-s0': 'sentinel S0 guard',
  'mpl-sentinel-s1': 'sentinel S1 guard',
  'mpl-sentinel-s3': 'sentinel S3 guard',
  'mpl-permit-learner': 'permission learning telemetry',
  'mpl-sentinel-pp-file': 'PP file sentinel',
  'mpl-context-monitor': 'chain context usage monitor',
  'mpl-discovery-scanner': 'discovery sentinel scanner',
  'mpl-phase-controller': 'Stop hook phase routing and hang/block handling',
  'mpl-compaction-tracker': 'compaction telemetry',
  'mpl-session-init': 'session initialization',
  'mpl-keyword-detector': 'MPL keyword/slash command detection',
  // #237 D1: hooks added after the original map was authored. Verified
  // by comparing hooks.json registered ids against PURPOSES keys.
  'mpl-require-test-agent-brief': 'test-agent brief validation gate (PreToolUse on Task)',
};

const DECOMPOSITION_PATH = '.mpl/mpl/decomposition.yaml';
const DECOMPOSITION_FOCUS = new Set([
  'mpl-require-goal-trace',
  'mpl-baseline-guard',
  'mpl-artifact-schema',
  'mpl-discovery-scanner',
  'mpl-require-chain-assignment',
  'mpl-phase-controller',
  'mpl-require-test-agent',
]);

// #237 D3: hooks that read state.json fields. A trace of
// `.mpl/state.json` should narrow to these instead of including every
// Edit/Write hook (most of which never touch state). Hooks not in the
// set still appear when there's an active blocker or when the matcher
// hits the queried tool.
const STATE_FOCUS = new Set([
  'mpl-state-invariant',
  'mpl-phase-controller',
  'mpl-gate-recorder',
  'mpl-tool-tracker',
  'mpl-context-monitor',
  'mpl-require-test-agent',
  'mpl-require-finalize-artifacts',
  'mpl-require-completed-phase-immutability',
  'mpl-require-phase-evidence',
  'mpl-require-whole-goal-closure',
  'mpl-baseline-guard',
  'mpl-require-decomposition-delta',
  'mpl-decomposition-postprocess',
  'mpl-require-test-agent-brief',
]);

function readHooksConfig(pluginRoot = DEFAULT_PLUGIN_ROOT) {
  const path = join(pluginRoot, 'hooks', 'hooks.json');
  return JSON.parse(readFileSync(path, 'utf-8'));
}

// #237 D1: regression hook so tests can audit PURPOSES against the
// live hooks.json registry. Returns the list of hook ids registered
// in hooks.json that are missing from the PURPOSES map. An empty
// array means every registered hook has a concrete label.
export function findPurposeGaps(pluginRoot = DEFAULT_PLUGIN_ROOT) {
  const config = readHooksConfig(pluginRoot);
  const registered = new Set();
  for (const regs of Object.values(config.hooks || {})) {
    for (const r of regs || []) {
      for (const h of r.hooks || []) {
        registered.add(hookIdFromCommand(h.command));
      }
    }
  }
  return [...registered].filter((id) => !(id in PURPOSES)).sort();
}

function hookIdFromCommand(command) {
  if (typeof command !== 'string') return 'unknown';
  const match = command.match(/\/([^/\s"']+\.mjs)\b/);
  const file = match ? match[1] : basename(command.trim().split(/\s+/).pop() || 'unknown');
  return file.replace(/\.mjs$/, '');
}

function matcherTools(matcher) {
  if (!matcher) return ['*'];
  return String(matcher)
    .split('|')
    .map((p) => p.trim())
    .filter(Boolean);
}

function matcherIncludes(matcher, tools) {
  const patterns = matcherTools(matcher);
  if (patterns.includes('*')) return true;
  return patterns.some((pattern) => {
    if (pattern === 'mcp__.*') return tools.some((t) => t.startsWith('mcp__'));
    if (pattern.includes('.*')) {
      const re = new RegExp(`^${pattern.replace(/\./g, '\\.').replace(/\*/g, '.*')}$`);
      return tools.some((tool) => re.test(tool));
    }
    return tools.includes(pattern);
  });
}

function pathCategory(targetPath) {
  const normalized = String(targetPath || '').replace(/\\/g, '/');
  if (normalized.endsWith(DECOMPOSITION_PATH) || normalized === DECOMPOSITION_PATH) {
    return 'decomposition';
  }
  if (normalized.endsWith('.mpl/state.json')) return 'state';
  return 'file';
}

function shouldIncludeHook({ eventName, matcher, hookId, category }) {
  const fileWriteTools = ['Edit', 'Write', 'MultiEdit'];
  if (eventName === 'PreToolUse') {
    // #237 D3: state-category trace narrows file-write PreToolUse hooks
    // to the ones that actually read state. The decomposition branch
    // already had its own focus filter.
    if (category === 'state' && matcherIncludes(matcher, fileWriteTools)) {
      return STATE_FOCUS.has(hookId);
    }
    if (matcherIncludes(matcher, fileWriteTools)) return true;
    if (category === 'decomposition' && matcherIncludes(matcher, ['Task', 'Agent'])) return true;
    return !matcher;
  }
  if (eventName === 'PostToolUse') {
    if (category === 'state' && matcherIncludes(matcher, fileWriteTools)) {
      return STATE_FOCUS.has(hookId);
    }
    if (matcherIncludes(matcher, fileWriteTools)) return true;
    if (category === 'decomposition' && matcherIncludes(matcher, ['Task', 'Agent'])) return true;
    return !matcher;
  }
  if (eventName === 'Stop') return true;
  if (category === 'decomposition') return DECOMPOSITION_FOCUS.has(hookId);
  if (category === 'state') return STATE_FOCUS.has(hookId);
  return false;
}

function blockStatusFor(hookId, state, targetPath) {
  if (!state || state.session_status !== 'blocked_hook') return 'registered';
  if (state.blocked_by_hook !== hookId) return 'registered';
  // Codex r2/r3 on PR #216: a blocked_hook envelope is only actionable
  // when ALL companion fields required by the state-invariant are present
  // (blocked_phase, block_code, block_reason, resume_instruction,
  // blocked_at, retry_context object — same list as
  // mpl-state-invariant BLOCKED_HOOK_STALE). A stale or partially-cleared
  // zombie state would otherwise print BLOCKING for the requested target
  // and hide the real state-invariant failure. Reuse the shared validator.
  const missing = missingBlockedHookFields(state);
  if (missing.length > 0) {
    return 'invalid_blocked_envelope';
  }
  const artifact = String(state.blocked_artifact || '').trim();
  const target = String(targetPath || '').trim();
  if (!target) {
    return 'invalid_blocked_envelope';
  }
  // #237 D2: slash-boundary match. Bidirectional endsWith without a
  // boundary was overly permissive — target `foo.yaml` matched stored
  // artifact `barfoo.yaml` and vice versa. Now either exact match OR
  // suffix match where the boundary is a `/` separator.
  if (
    artifact === target ||
    (artifact && target.endsWith('/' + artifact)) ||
    (target && artifact.endsWith('/' + target))
  ) {
    return 'currently_blocking';
  }
  return 'registered_blocking_other_artifact';
}

export function traceHookChain({
  targetPath,
  cwd = process.cwd(),
  pluginRoot = DEFAULT_PLUGIN_ROOT,
  hooksConfig = null,
  state = null,
} = {}) {
  const resolvedTarget = targetPath || DECOMPOSITION_PATH;
  const config = hooksConfig || readHooksConfig(pluginRoot);
  // state can be either a parsed state object (when caller injects one)
  // or null / { error, ... } / { state } from readStateRaw.
  let activeState = null;
  let stateError = null;
  if (state) {
    activeState = state;
  } else {
    const raw = readStateRaw(cwd);
    if (raw && raw.error) {
      stateError = raw;
    } else if (raw && raw.state) {
      activeState = raw.state;
    }
  }
  const category = pathCategory(resolvedTarget);
  const rows = [];

  // Codex r4/r5 on PR #216: when there is an active blocked_hook envelope
  // that names the queried target, the offending hook MUST appear in the
  // trace regardless of the category/matcher filter AND regardless of
  // whether the envelope is complete. blockStatusFor decides between
  // currently_blocking (complete envelope) and invalid_blocked_envelope
  // (stale/corrupt envelope); both diagnoses are useful and either is
  // better than silently filtering out the hook that is actually keeping
  // the run blocked.
  //
  // Codex r8 / #217: drop the artifact-match precondition entirely. If
  // the envelope is STALE and missing blocked_artifact, the prior
  // version silently filtered the active blocker out via category check
  // — so tracing any non-matching target while paused returned a row
  // set that looked healthy. Force-include is now triggered by
  // session_status === 'blocked_hook' + non-empty blocked_by_hook
  // alone; the missing artifact case shows up as
  // invalid_blocked_envelope per blockStatusFor.
  const activeBlockHookId = activeState
    && activeState.session_status === 'blocked_hook'
    ? String(activeState.blocked_by_hook || '').trim()
    : null;

  for (const [eventName, registrations] of Object.entries(config.hooks || {})) {
    for (const registration of registrations || []) {
      const matcher = registration.matcher || null;
      for (const hook of registration.hooks || []) {
        const hookId = hookIdFromCommand(hook.command);
        const isActiveBlocker = activeBlockHookId && hookId === activeBlockHookId;
        if (!isActiveBlocker && !shouldIncludeHook({ eventName, matcher, hookId, category })) continue;
        rows.push({
          event: eventName,
          matcher: matcher || '*',
          hook_id: hookId,
          command: hook.command,
          timeout: hook.timeout ?? null,
          purpose: PURPOSES[hookId] || 'registered hook',
          status: blockStatusFor(hookId, activeState, resolvedTarget),
        });
      }
    }
  }

  // Codex r7 on PR #216 + #217: synthetic row when the active blocker
  // hook id is no longer registered (hooks.json rename / upgrade).
  // Same artifact-match relaxation: if there is an active blocker, we
  // surface it even when the envelope is stale.
  if (
    activeBlockHookId &&
    !rows.some((r) => r.hook_id === activeBlockHookId)
  ) {
    rows.push({
      event: 'state',
      matcher: 'blocked_by_hook',
      hook_id: activeBlockHookId,
      command: null,
      timeout: null,
      purpose: 'active blocker not registered in current hooks.json (registry skew)',
      status: blockStatusFor(activeBlockHookId, activeState, resolvedTarget),
    });
  }

  return {
    target_path: resolvedTarget,
    category,
    cwd,
    plugin_root: pluginRoot,
    state_error: stateError,
    hooks: rows,
  };
}

export function formatHookTrace(trace) {
  const lines = [
    `MPL Hook Trace: ${trace.target_path}`,
    `category: ${trace.category}`,
    '',
  ];
  if (trace.state_error) {
    if (trace.state_error.error === 'unsupported_schema') {
      lines.push(`WARNING: state.json schema_version=${trace.state_error.schemaVersion} is newer than the installed plugin supports — upgrade the plugin or restore a compatible state before relying on this trace.`);
    } else if (trace.state_error.error === 'unparseable') {
      lines.push('WARNING: .mpl/state.json is unreadable / not valid JSON — block status cannot be computed for this trace.');
    }
    lines.push('');
  }
  if (!trace.hooks.length) {
    lines.push('No matching hooks registered.');
    return lines.join('\n');
  }

  let currentEvent = null;
  for (const hook of trace.hooks) {
    if (hook.event !== currentEvent) {
      currentEvent = hook.event;
      lines.push(`${currentEvent}:`);
    }
    let marker;
    if (hook.status === 'currently_blocking') marker = 'BLOCKING';
    else if (hook.status === 'invalid_blocked_envelope') marker = 'INVALID_BLOCKED_ENVELOPE';
    else marker = hook.status;
    lines.push(`  - ${hook.hook_id} [${marker}] matcher=${hook.matcher} :: ${hook.purpose}`);
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = { cwd: process.cwd(), pluginRoot: DEFAULT_PLUGIN_ROOT, json: false, targetPath: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cwd') args.cwd = argv[++i] || args.cwd;
    else if (arg === '--plugin-root') args.pluginRoot = argv[++i] || args.pluginRoot;
    else if (arg === '--json') args.json = true;
    else if (!args.targetPath) args.targetPath = arg;
  }
  return args;
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  const args = parseArgs(process.argv.slice(2));
  const target = args.targetPath || DECOMPOSITION_PATH;
  const trace = traceHookChain({
    targetPath: target,
    cwd: args.cwd,
    pluginRoot: args.pluginRoot,
  });
  process.stdout.write(args.json
    ? `${JSON.stringify(trace, null, 2)}\n`
    : `${formatHookTrace(trace)}\n`);
}
