#!/usr/bin/env node
/**
 * MPL Auto-Permission Hook (PreToolUse)
 * Auto-approves non-critical tool calls during MPL execution,
 * so the user is only prompted for critical/plan-related operations.
 *
 * Supports learned allowlist: tools approved by the user once are
 * auto-approved in subsequent calls within the same pipeline.
 *
 * When MPL inactive: no interference (pass through)
 * When MPL active:
 *   - Auto-approve: Read, Glob, Grep, Agent, Task, safe Bash, learned tools
 *   - Pass through (user decides): destructive Bash, Edit/Write (handled by write-guard)
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { isMplActive } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);

const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);

const { isLearnedTool, isLearnedBashCommand } = await import(
  pathToFileURL(join(__dirname, 'lib', 'permit-store.mjs')).href
);

// Tools that are always safe to auto-approve
const ALWAYS_SAFE_TOOLS = new Set([
  'Read', 'Glob', 'Grep',
  'Agent', 'Task',
  'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TaskOutput',
  'WebSearch', 'WebFetch',
  'AskUserQuestion',
  'NotebookEdit',
  'ToolSearch',
]);

// Tools handled by other hooks (write-guard) — don't interfere
const DEFER_TOOLS = new Set(['Edit', 'Write']);

// Destructive Bash patterns — must NOT auto-approve (even if learned)
const DANGEROUS_BASH_PATTERNS = [
  /git\s+push\s+.*--force/,
  /git\s+push\s+-f\b/,
  /git\s+reset\s+--hard/,
  /git\s+branch\s+-[dD]\s/,
  /git\s+checkout\s+--\s/,
  /git\s+clean\s+-f/,
  /\brm\s+-rf?\s+(?!\.mpl)/,     // rm -rf on non-.mpl paths
  /\bsudo\b/,
  /DROP\s+TABLE/i,
  /DELETE\s+FROM/i,
  /\bgit\s+rebase\b/,
  /\bgit\s+merge\b/,
  /\bgit\s+stash\s+drop\b/,
];

// Safe Bash command prefixes — auto-approve these
const SAFE_BASH_PREFIXES = [
  'git status', 'git diff', 'git log', 'git show', 'git branch',
  'git add', 'git commit',
  'ls', 'pwd', 'which', 'echo', 'cat', 'head', 'tail', 'wc',
  'node ', 'npm ', 'npx ', 'pnpm ', 'yarn ',
  'python ', 'python3 ', 'pip ', 'pytest ', 'uv ',
  'cargo ', 'go ', 'make ', 'cmake ',
  'tsc ', 'eslint ', 'prettier ',
  'grep ', 'rg ', 'find ', 'ag ',
  'curl ', 'wget ',
  'mkdir ', 'touch ', 'cp ',
  'git checkout -b', 'git switch',
  'gh ',
  'cd ',
  'date', 'whoami', 'env',
];

// Export for permit-learner to check
export { ALWAYS_SAFE_TOOLS, DEFER_TOOLS, SAFE_BASH_PREFIXES, DANGEROUS_BASH_PATTERNS };

function isDangerousBash(command) {
  if (!command) return false;
  return DANGEROUS_BASH_PATTERNS.some(pattern => pattern.test(command));
}

function isSafeBash(command) {
  if (!command) return false;
  const trimmed = command.trim();
  return SAFE_BASH_PREFIXES.some(prefix => trimmed.startsWith(prefix));
}

async function main() {
  const input = await readStdin();

  let data;
  try {
    data = JSON.parse(input);
  } catch {
    // Parse error: pass through
    console.log(JSON.stringify({}));
    return;
  }

  const toolName = data.tool_name || data.toolName || '';

  // Check if MPL is active
  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) {
    // MPL inactive: no interference
    console.log(JSON.stringify({}));
    return;
  }

  // Don't interfere with tools handled by other hooks (write-guard)
  if (DEFER_TOOLS.has(toolName)) {
    console.log(JSON.stringify({}));
    return;
  }

  // Always-safe tools: auto-approve
  if (ALWAYS_SAFE_TOOLS.has(toolName)) {
    console.log(JSON.stringify({ decision: 'approve' }));
    return;
  }

  // Check learned allowlist (tools approved by user in this pipeline)
  if (isLearnedTool(cwd, toolName)) {
    console.log(JSON.stringify({ decision: 'approve' }));
    return;
  }

  // Bash: check command safety
  if (toolName === 'Bash') {
    const toolInput = data.tool_input || data.toolInput || {};
    const command = toolInput.command || '';

    // Dangerous patterns always block (even if learned)
    if (isDangerousBash(command)) {
      console.log(JSON.stringify({}));
      return;
    }

    // Built-in safe prefixes
    if (isSafeBash(command)) {
      console.log(JSON.stringify({ decision: 'approve' }));
      return;
    }

    // Learned Bash prefixes
    if (isLearnedBashCommand(cwd, command)) {
      console.log(JSON.stringify({ decision: 'approve' }));
      return;
    }

    // Unknown bash command: auto-approve (fail-open for productivity)
    console.log(JSON.stringify({ decision: 'approve' }));
    return;
  }

  // Unknown tool: pass through (user decides) → learner will capture if approved
  console.log(JSON.stringify({}));
}

main().catch(() => {
  // On error: pass through (fail-open)
  console.log(JSON.stringify({}));
});
