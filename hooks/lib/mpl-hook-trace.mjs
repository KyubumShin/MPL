#!/usr/bin/env node
import { existsSync, readFileSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import { missingBlockedHookFields } from './mpl-blocked-hook.mjs';

// Read .mpl/state.json byte-for-byte without invoking readState() — that
// helper persists schema migrations and can archive/remove the legacy
// `.mpl/mpl/state.json`. A diagnostic command must never mutate run state
// just by being run; codex r1 on PR #216 flagged this as a state-forensics
// hazard. Return null when the file is missing or unparseable; callers
// treat null as "no active blocked_hook info available".
function readStateRaw(cwd) {
  const path = join(cwd, '.mpl', 'state.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
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

function readHooksConfig(pluginRoot = DEFAULT_PLUGIN_ROOT) {
  const path = join(pluginRoot, 'hooks', 'hooks.json');
  return JSON.parse(readFileSync(path, 'utf-8'));
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
    if (matcherIncludes(matcher, fileWriteTools)) return true;
    if (category === 'decomposition' && matcherIncludes(matcher, ['Task', 'Agent'])) return true;
    return !matcher;
  }
  if (eventName === 'PostToolUse') {
    if (matcherIncludes(matcher, fileWriteTools)) return true;
    if (category === 'decomposition' && matcherIncludes(matcher, ['Task', 'Agent'])) return true;
    return !matcher;
  }
  if (eventName === 'Stop') return true;
  if (category === 'decomposition') return DECOMPOSITION_FOCUS.has(hookId);
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
  if (artifact === target || target.endsWith(artifact) || artifact.endsWith(target)) {
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
  const activeState = state || readStateRaw(cwd);
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
  const activeBlockHookId = activeState
    && activeState.session_status === 'blocked_hook'
    ? String(activeState.blocked_by_hook || '').trim()
    : null;
  const activeBlockArtifact = activeBlockHookId
    ? String(activeState.blocked_artifact || '').trim()
    : null;
  const resolvedTargetTrim = String(resolvedTarget).trim();
  const activeBlockMatchesTarget = activeBlockArtifact && resolvedTargetTrim && (
    activeBlockArtifact === resolvedTargetTrim ||
    resolvedTargetTrim.endsWith(activeBlockArtifact) ||
    activeBlockArtifact.endsWith(resolvedTargetTrim)
  );

  for (const [eventName, registrations] of Object.entries(config.hooks || {})) {
    for (const registration of registrations || []) {
      const matcher = registration.matcher || null;
      for (const hook of registration.hooks || []) {
        const hookId = hookIdFromCommand(hook.command);
        const isActiveBlocker = activeBlockMatchesTarget && hookId === activeBlockHookId;
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

  return {
    target_path: resolvedTarget,
    category,
    cwd,
    plugin_root: pluginRoot,
    hooks: rows,
  };
}

export function formatHookTrace(trace) {
  const lines = [
    `MPL Hook Trace: ${trace.target_path}`,
    `category: ${trace.category}`,
    '',
  ];
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
