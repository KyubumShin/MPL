#!/usr/bin/env node
/**
 * MPL Permit Learner Hook (PostToolUse)
 * Learns from user-approved tool calls to build an adaptive allowlist.
 *
 * When a tool completes that isn't in the built-in safe list,
 * it means the user approved it → save to learned allowlist.
 * Next time the same tool/command is used, auto-permit will auto-approve it.
 *
 * Dangerous Bash patterns are never learned (blocklist overrides learning).
 * Edit/Write are excluded (handled by write-guard, not permit system).
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

const {
  addLearnedTool,
  addLearnedBashPrefix,
  extractBashPrefix,
  isLearnedTool,
  isLearnedBashCommand,
} = await import(
  pathToFileURL(join(__dirname, 'lib', 'permit-store.mjs')).href
);

// Import lists from auto-permit to know what's already covered
const {
  ALWAYS_SAFE_TOOLS,
  DEFER_TOOLS,
  SAFE_BASH_PREFIXES,
  DANGEROUS_BASH_PATTERNS,
} = await import(
  pathToFileURL(join(__dirname, 'mpl-auto-permit.mjs')).href
);

function isDangerousBash(command) {
  if (!command) return false;
  return DANGEROUS_BASH_PATTERNS.some(pattern => pattern.test(command));
}

function isBuiltinSafeBash(command) {
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
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const toolName = data.tool_name || data.toolName || '';
  const cwd = data.cwd || data.directory || process.cwd();

  // Only learn when MPL is active
  if (!isMplActive(cwd)) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Skip tools that are already in built-in lists (no need to learn)
  if (ALWAYS_SAFE_TOOLS.has(toolName) || DEFER_TOOLS.has(toolName)) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Handle Bash commands
  if (toolName === 'Bash') {
    const toolInput = data.tool_input || data.toolInput || {};
    const command = toolInput.command || '';

    // Never learn dangerous patterns
    if (isDangerousBash(command)) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    // Skip if already known (built-in or learned)
    if (isBuiltinSafeBash(command) || isLearnedBashCommand(cwd, command)) {
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      return;
    }

    // Learn the prefix of this approved Bash command
    const prefix = extractBashPrefix(command);
    if (prefix) {
      addLearnedBashPrefix(cwd, prefix);
    }

    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Handle non-Bash tools
  if (!isLearnedTool(cwd, toolName)) {
    // This tool completed successfully but wasn't in any safe list
    // → user must have approved it → learn it
    addLearnedTool(cwd, toolName);
  }

  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

main().catch(() => {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
});
