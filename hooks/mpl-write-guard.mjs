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

// Safe cleanup patterns that look dangerous but are common/expected
const SAFE_CLEANUP_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force\s+)(\.\/)?node_modules/,
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force\s+)(\.\/)?\.next/,
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force\s+)(\.\/)?dist/,
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force\s+)(\.\/)?build/,
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force\s+)(\.\/)?\.cache/,
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force\s+)(\.\/)?coverage/,
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force\s+)(\.\/)?__pycache__/,
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force\s+)(\.\/)?\.mpl/,
];

function isDangerousBashCommand(command) {
  if (!command) return false;
  // Check safe cleanup first (allowlist takes priority)
  if (SAFE_CLEANUP_PATTERNS.some(p => p.test(command))) return false;
  return DANGEROUS_BASH_PATTERNS.some(p => p.test(command));
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

  // Only intercept Edit, Write, and Bash tools
  if (!['Edit', 'Write', 'edit', 'write', 'Bash', 'bash'].includes(toolName)) {
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

  // --- Bash dangerous command check (T-01, v3.8) ---
  if (['Bash', 'bash'].includes(toolName)) {
    const command = toolInput.command || '';
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

  // Check if path is allowed for orchestrator (honours dogfood mode).
  if (isAllowedPath(filePath, { dogfood })) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Check if it's a source file → resolve direct_source_edit policy.
  if (isSourceFile(filePath)) {
    const action = resolveRuleAction(cwd, state, 'direct_source_edit');
    if (action === 'off') {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }
    const dogfoodTag = dogfood ? ' [dogfood mode: MPL/ also enforced]' : '';
    const message = `[MPL DELEGATION NOTICE] Direct ${toolName} on source file: ${filePath}${dogfoodTag}

Source files should be edited by mpl-phase-runner agents, not the orchestrator.
Delegate via: Agent(subagent_type="mpl-phase-runner", prompt="Edit ${filePath} to ...")`;

    if (action === 'block') {
      console.log(JSON.stringify({
        decision: 'block',
        reason: message,
      }));
      return;
    }
    // warn (transitional default)
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
            console.log(JSON.stringify({ continue: true, suppressOutput: true }));
            return;
          }
          const message = `[MPL SCOPE WARNING] File "${filePath}" is outside phase "${currentPhase}" scope.
Declared scope files: ${scope.allowed.slice(0, 5).join(', ')}${scope.allowed.length > 5 ? ` (+${scope.allowed.length - 5} more)` : ''}

This may cause cross-phase side effects. Verify this modification belongs in the current phase.`;

          if (action === 'block') {
            console.log(JSON.stringify({
              decision: 'block',
              reason: message,
            }));
            return;
          }
          // warn
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

  // All checks passed: allow
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

main().catch(() => {
  // On error: allow (fail-open for safety)
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
});

export { isAllowedPath, isSourceFile, isDangerousBashCommand, isDogfoodMode };
