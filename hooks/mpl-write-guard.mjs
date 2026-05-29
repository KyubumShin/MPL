#!/usr/bin/env node
/**
 * MPL Write Guard Hook (PreToolUse)
 *
 * Two responsibilities:
 * 1. Blocks orchestrator from directly editing source files when MPL is active.
 *    Source file edits must be delegated to mpl-phase-runner agents.
 * 2. Warns on dangerous Bash commands (rm -rf, DROP TABLE, git push --force, etc.)
 *    that could cause irreversible damage. (T-01)
 * 3. Phase-scoped file lock — warns on writes outside current phase's scope. (T-01 P2)
 *
 * When MPL is inactive: does nothing (no interference with normal workflow)
 * When MPL is active: guards Edit/Write on source files + warns on dangerous Bash
 */

import { dirname, join, extname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import shared MPL state utility
const { isMplActive, readState } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);

// Import shared stdin reader
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);

// Import decomposition parser for phase-scoped file lock (T-01 Phase 2, v3.9)
const { getPhaseScope } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-decomposition-parser.mjs')).href
);

// P0-2 / #110 — per-rule policy resolver. P0-3 (#111) consumes
// `direct_source_edit` and `phase_scope_violation`.
const { resolveRuleAction } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-enforcement.mjs')).href
);
const { loadConfig } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-config.mjs')).href
);
// #235: record envelope on `decision: block` so mpl-recover can
// dispatch and BLOCKED_HOOK_STALE doesn't fire.
const { recordBlockedHook, clearBlockedHook } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-blocked-hook.mjs')).href
);
// #236: state-based subagent dispatch tracking so the decomposition.yaml
// writer-identity check can verify it's the decomposer subagent.
// (readState already imported above with isMplActive.)
const { writeState } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);

const HOOK_ID = 'mpl-write-guard';

// #236 A1: orchestrator MUST NOT directly Write/Edit
// `.mpl/mpl/decomposition.yaml`. Only the mpl-decomposer agent may
// (commands/mpl-run-decompose.md:16). We detect the writer identity
// via a state-based dispatch flag set when the orchestrator dispatches
// Agent(subagent_type='mpl-decomposer') and cleared on Stop.
const DECOMPOSITION_FILE_REGEX = /(^|\/)\.mpl\/mpl\/decomposition\.ya?ml$/;
const DECOMPOSER_SUBAGENT_TYPES = new Set([
  'mpl-decomposer',
  'mpl:mpl-decomposer',
]);
// Dispatch flag lifetime in ms — a real decompose run typically
// completes in a few minutes; 30 min is a conservative ceiling.
const DECOMPOSER_DISPATCH_TTL_MS = 30 * 60 * 1000;

// #236 A3: skill mpl-cancel declares these paths NEVER deletable.
// The dangerous-bash check used to allowlist `rm -rf .mpl` as "safe
// cleanup" — that allowed the exact destructive op the SKILL forbids.
// Fix: every rm against any of these (or any descendant) is hard-blocked
// regardless of the safe-cleanup allowlist. Override via env var
// MPL_FORCE_PURGE=1 — operators initiating a real reset can set this
// in the same shell.
const PROTECTED_DELETE_TARGETS = [
  '.mpl/mpl',
  '.mpl/contracts',
  '.mpl/memory',
  'docs/learnings',
];

// Dogfood mode (P0-3, #111): when developing the MPL plugin against itself,
// `/MPL/` paths must be treated like ordinary source — orchestrator should
// route those edits through phase-runner the same as application code.
// Toggle via .mpl/config.json `dogfood: true` or env `MPL_DOGFOOD=1`.
const DOGFOOD_SUPPRESSED = /\/MPL\//;

// Allowed path patterns (orchestrator CAN write to these). DOGFOOD_SUPPRESSED
// is included by reference so isAllowedPath() can drop it when dogfood is on.
const ALLOWED_PATTERNS = [
  /\.mpl\//,           // .mpl/ state directory
  /\.omc\//,           // .omc/ OMC state
  /\.claude\//,        // .claude/ config
  /\/\.claude\//,      // absolute .claude/ paths
  DOGFOOD_SUPPRESSED,  // /MPL/ plugin directory (suppressed in dogfood mode)
  /PLAN\.md$/,         // PLAN.md (orchestrator manages checkboxes)
  /docs\/learnings\//, // learnings directory
];

function isDogfoodMode(cwd) {
  if (process.env.MPL_DOGFOOD === '1') return true;
  try {
    const cfg = loadConfig(cwd);
    return cfg?.dogfood === true;
  } catch {
    return false;
  }
}

// Source file extensions (orchestrator must NOT write to these)
const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.pyw',
  '.go', '.rs', '.java', '.kt', '.scala',
  '.c', '.cpp', '.cc', '.h', '.hpp',
  '.rb', '.php',
  '.svelte', '.vue',
  '.css', '.scss', '.less',
  '.html', '.htm',
  '.json', '.yaml', '.yml', '.toml',
  '.sql',
  '.sh', '.bash', '.zsh',
]);

// Dangerous Bash command patterns (T-01, v3.8)
const DANGEROUS_BASH_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force)/,   // rm -rf, rm -f, rm --force
  /\bgit\s+push\s+.*--force/,                        // git push --force
  /\bgit\s+reset\s+--hard/,                          // git reset --hard
  /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i,              // DROP TABLE/DATABASE/SCHEMA
  /\bTRUNCATE\s+TABLE\b/i,                            // TRUNCATE TABLE
  /\bkubectl\s+delete\b/,                             // kubectl delete
  /\bdocker\s+rm\s+(-[a-zA-Z]*f|--force)/,           // docker rm -f
  /\bdocker\s+system\s+prune/,                        // docker system prune
  /\bchmod\s+777\b/,                                  // chmod 777
];

// Safe cleanup patterns that look dangerous but are common/expected.
// #236 A3 removed `.mpl` from this set — it conflicted with the
// mpl-cancel SKILL contract that explicitly forbids deleting any of
// `.mpl/mpl/**`, `.mpl/contracts/*.json`, `.mpl/memory/`, and
// `docs/learnings/`. The protected-delete check (matchesProtectedDelete)
// runs BEFORE the dangerous-bash check now and hard-blocks regardless
// of this allowlist.
const SAFE_CLEANUP_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force\s+)(\.\/)?node_modules/,
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force\s+)(\.\/)?\.next/,
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force\s+)(\.\/)?dist/,
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force\s+)(\.\/)?build/,
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force\s+)(\.\/)?\.cache/,
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force\s+)(\.\/)?coverage/,
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force\s+)(\.\/)?__pycache__/,
];

function isDangerousBashCommand(command) {
  if (!command) return false;
  // Check safe cleanup first (allowlist takes priority)
  if (SAFE_CLEANUP_PATTERNS.some(p => p.test(command))) return false;
  return DANGEROUS_BASH_PATTERNS.some(p => p.test(command));
}

// #236 A3: does `command` attempt to remove any PROTECTED_DELETE_TARGETS
// path (or one of its descendants)? Returns the matched target on hit,
// null otherwise. Matches the canonical `rm` family — `rm`, `rm -r*`,
// `rm -f*`, `rm --force`, and the wrapped `find ... -delete` form.
// The check is conservative — over-matching is acceptable because the
// MPL_FORCE_PURGE escape hatch exists for legitimate cleanup.
function matchesProtectedDelete(command) {
  if (!command || typeof command !== 'string') return null;
  // Strip leading `sudo ` etc. before checking the head — `sudo rm -rf .mpl/mpl`
  // must still trip.
  const normalized = command.replace(/^\s*(sudo|time|nice|env)\s+/, '').trim();
  // Identify rm calls — `rm`, `rm -*`, `\brm\b` inside a pipeline, etc.
  if (!/\brm\b/.test(normalized) && !/\bfind\b.*-delete\b/.test(normalized)) {
    return null;
  }
  for (const target of PROTECTED_DELETE_TARGETS) {
    // Whole target OR `target/` prefix to catch descendants.
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[\\s'"])(\\./)?${escaped}(/|\\b|['"])`);
    if (re.test(normalized)) return target;
  }
  return null;
}

// #236 A1: record state.decomposer_dispatch when the orchestrator
// dispatches Agent(subagent_type='mpl-decomposer'). Used by the
// decomposition.yaml writer-identity check below.
function recordDecomposerDispatch(cwd) {
  try {
    writeState(cwd, {
      decomposer_dispatch: {
        dispatched_at: new Date().toISOString(),
      },
    });
  } catch { /* best-effort */ }
}

// #236 A1: is a decomposer subagent currently expected to be running?
// True when state.decomposer_dispatch.dispatched_at is within the TTL.
function isDecomposerDispatchActive(cwd, state) {
  const flag = state?.decomposer_dispatch;
  if (!flag || typeof flag.dispatched_at !== 'string') return false;
  const ts = Date.parse(flag.dispatched_at);
  if (Number.isNaN(ts)) return false;
  return (Date.now() - ts) <= DECOMPOSER_DISPATCH_TTL_MS;
}

function isAllowedPath(filePath, opts = {}) {
  if (!filePath) return true;
  const { dogfood = false } = opts;
  return ALLOWED_PATTERNS.some((pattern) => {
    if (dogfood && pattern === DOGFOOD_SUPPRESSED) return false;
    return pattern.test(filePath);
  });
}

function isSourceFile(filePath) {
  if (!filePath) return false;
  return SOURCE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

async function main() {
  const input = await readStdin();

  let data;
  try {
    data = JSON.parse(input);
  } catch {
    // Parse error: allow and suppress
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const toolName = data.tool_name || data.toolName || '';

  // Tool sets we care about. Task/Agent only used for the decomposer
  // dispatch flag (A1); Bash for the safety + protected-delete check
  // (A3); Edit/Write/MultiEdit for the source-file / phase-scope /
  // decomposition-writer checks.
  const isWriteTool = ['Edit', 'Write', 'MultiEdit', 'edit', 'write', 'multiEdit', 'multiedit'].includes(toolName);
  const isBashTool = ['Bash', 'bash'].includes(toolName);
  const isTaskTool = ['Task', 'Agent', 'task', 'agent'].includes(toolName);
  if (!isWriteTool && !isBashTool && !isTaskTool) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Check if MPL is active
  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) {
    // MPL inactive: no interference
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const toolInput = data.tool_input || data.toolInput || {};

  // --- #236 A1 part 1: record decomposer dispatch when the orchestrator
  // calls Agent(subagent_type='mpl-decomposer'). The state flag is
  // consumed by the decomposition.yaml writer-identity check below
  // when the decomposer subsequently calls Write/Edit.
  if (isTaskTool) {
    const sub = String(toolInput.subagent_type || toolInput.subagentType || '');
    if (DECOMPOSER_SUBAGENT_TYPES.has(sub)) {
      recordDecomposerDispatch(cwd);
    }
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // --- Bash dangerous command check (T-01, v3.8) + #236 A3 ---
  if (isBashTool) {
    const command = toolInput.command || '';
    // #236 A3: protected-path delete — hard-block regardless of safe-cleanup
    // allowlist. Override via env MPL_FORCE_PURGE=1 set by the operator.
    const protectedTarget = matchesProtectedDelete(command);
    if (protectedTarget && process.env.MPL_FORCE_PURGE !== '1') {
      const reason =
        `[MPL #236 A3] Refused destructive write to protected path "${protectedTarget}". ` +
        `Command: \`${command}\`. The mpl-cancel skill (skills/mpl-cancel/SKILL.md) forbids ` +
        `deleting any of: ${PROTECTED_DELETE_TARGETS.join(', ')} (decomposition / contracts / ` +
        `cross-session memory / learnings). If you are running a real reset, set MPL_FORCE_PURGE=1 ` +
        `in the same shell, OR invoke /mpl:mpl-cancel which performs an auditable cleanup.`;
      const state = readState(cwd) || {};
      recordBlockedHook(cwd, {
        hookId: HOOK_ID,
        phaseId: state?.current_phase,
        artifact: protectedTarget,
        code: 'protected_path_delete',
        reason,
        resumeInstruction:
          `Either run /mpl:mpl-cancel (auditable cleanup that preserves intended state) or set MPL_FORCE_PURGE=1 in the same shell if you really want this rm to proceed, then retry.`,
        retryContext: { command, target: protectedTarget },
      });
      console.log(JSON.stringify({
        continue: false,
        decision: 'block',
        reason,
      }));
      return;
    }
    if (isDangerousBashCommand(command)) {
      const message = `[MPL SAFETY WARNING] Potentially dangerous command detected:
  ${command}

This command may cause irreversible changes. If this is intentional (e.g., cleanup),
ensure you have the correct target path. The command will proceed, but please verify.`;

      console.log(JSON.stringify({
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: message
        }
      }));
      return;
    }
    // Safe Bash command: allow silently
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // --- Edit/Write source file guard (P0-3, #111) ---
  // Extract file path
  const filePath = toolInput.file_path || toolInput.filePath || '';

  if (!filePath) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const state = readState(cwd) || {};
  const dogfood = isDogfoodMode(cwd);

  // #236 A1: decomposition.yaml may ONLY be Written/Edited by the
  // mpl-decomposer subagent. The hook detects this via a dispatch
  // flag set when the orchestrator calls Agent(subagent_type=
  // 'mpl-decomposer') above; the flag has a 30-min TTL so a stale
  // marker can't permanently unlock the path. Any Write/Edit to
  // decomposition.yaml without an active dispatch — even from
  // inside another subagent — is blocked. The block precedes the
  // generic `isAllowedPath` (.mpl/* is otherwise an allowlisted
  // orchestrator path) so the writer identity wins.
  if (DECOMPOSITION_FILE_REGEX.test(filePath)) {
    if (!isDecomposerDispatchActive(cwd, state)) {
      const reason =
        `[MPL #236 A1] Refused direct ${toolName} of decomposition.yaml: ` +
        `the orchestrator must NOT write this file. Only the mpl-decomposer ` +
        `subagent may emit it (commands/mpl-run-decompose.md). Dispatch via ` +
        `Agent(subagent_type='mpl-decomposer', prompt='...') and let it write.`;
      recordBlockedHook(cwd, {
        hookId: HOOK_ID,
        phaseId: state?.current_phase,
        artifact: filePath,
        code: 'decomposition_writer_violation',
        reason,
        resumeInstruction:
          `Dispatch Agent(subagent_type='mpl-decomposer') and let it produce decomposition.yaml; do not Edit/Write it directly.`,
        retryContext: { file_path: filePath, tool: toolName },
      });
      console.log(JSON.stringify({
        continue: false,
        decision: 'block',
        reason,
      }));
      return;
    }
    // Decomposer dispatch is active — allow + clear any stale envelope.
    clearBlockedHook(cwd, { hookId: HOOK_ID, artifact: filePath });
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Check if path is allowed for orchestrator (honours dogfood mode).
  if (isAllowedPath(filePath, { dogfood })) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Check if it's a source file → resolve direct_source_edit policy.
  if (isSourceFile(filePath)) {
    const action = resolveRuleAction(cwd, state, 'direct_source_edit');
    if (action === 'off') {
      // Codex r2 on PR #246: explicit opt-out must clear any stale
      // envelope from a prior block for the same (hookId, filePath).
      clearBlockedHook(cwd, { hookId: HOOK_ID, artifact: filePath });
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }
    const dogfoodTag = dogfood ? ' [dogfood mode: MPL/ also enforced]' : '';
    const message = `[MPL DELEGATION NOTICE] Direct ${toolName} on source file: ${filePath}${dogfoodTag}

Source files should be edited by mpl-phase-runner agents, not the orchestrator.
Delegate via: Agent(subagent_type="mpl-phase-runner", prompt="Edit ${filePath} to ...")`;

    if (action === 'block') {
      recordBlockedHook(cwd, {
        hookId: HOOK_ID,
        phaseId: state?.current_phase,
        artifact: filePath,
        code: 'direct_source_edit',
        reason: message,
        resumeInstruction:
          'Delegate the source-file edit to an mpl-phase-runner agent (Agent(subagent_type=mpl-phase-runner, ...)), then retry.',
        retryContext: { file_path: filePath, tool: toolName },
      });
      console.log(JSON.stringify({
        decision: 'block',
        reason: message,
      }));
      return;
    }
    // warn (transitional default)
    clearBlockedHook(cwd, { hookId: HOOK_ID, artifact: filePath });
    console.log(JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: message,
      },
    }));
    return;
  }

  // --- Phase-Scoped File Lock (T-01 Phase 2, v3.9; P0-3 wiring) ---
  // Check if the file is within the current phase's declared scope.
  try {
    const currentPhase = state?.current_phase;
    if (currentPhase && filePath) {
      const scope = getPhaseScope(cwd, currentPhase);
      if (scope && scope.allowed.length > 0) {
        const inScope = scope.allowed.some((f) =>
          filePath.endsWith(f) || filePath.includes(f),
        );
        if (!inScope) {
          const action = resolveRuleAction(cwd, state, 'phase_scope_violation');
          if (action === 'off') {
            // Codex r2 on PR #246: explicit opt-out must clear any
            // stale envelope from a prior phase_scope_violation block.
            clearBlockedHook(cwd, { hookId: HOOK_ID, artifact: filePath });
            console.log(JSON.stringify({ continue: true, suppressOutput: true }));
            return;
          }
          const message = `[MPL SCOPE WARNING] File "${filePath}" is outside phase "${currentPhase}" scope.
Declared scope files: ${scope.allowed.slice(0, 5).join(', ')}${scope.allowed.length > 5 ? ` (+${scope.allowed.length - 5} more)` : ''}

This may cause cross-phase side effects. Verify this modification belongs in the current phase.`;

          if (action === 'block') {
            recordBlockedHook(cwd, {
              hookId: HOOK_ID,
              phaseId: currentPhase,
              artifact: filePath,
              code: 'phase_scope_violation',
              reason: message,
              resumeInstruction:
                `Restrict this write to files inside phase "${currentPhase}" declared scope, or move the work into the appropriate phase, then retry.`,
              retryContext: {
                file_path: filePath,
                phase: currentPhase,
                allowed_sample: scope.allowed.slice(0, 5),
              },
            });
            console.log(JSON.stringify({
              decision: 'block',
              reason: message,
            }));
            return;
          }
          // warn
          clearBlockedHook(cwd, { hookId: HOOK_ID, artifact: filePath });
          console.log(JSON.stringify({
            continue: true,
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              additionalContext: message,
            },
          }));
          return;
        }
      }
    }
  } catch {
    // Phase scope check failure: fail-open (don't block on parser errors)
  }

  // All checks passed: allow. Codex r2 on PR #246: a write that
  // passes both direct_source_edit AND phase_scope_violation means
  // any envelope previously recorded for THIS (HOOK_ID, filePath) is
  // resolved — clear it so mpl-recover/BLOCKED_HOOK_STALE see the
  // unblocked state.
  if (filePath) {
    clearBlockedHook(cwd, { hookId: HOOK_ID, artifact: filePath });
  }
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

main().catch(() => {
  // On error: allow (fail-open for safety)
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
});

export { isAllowedPath, isSourceFile, isDangerousBashCommand, isDogfoodMode };
