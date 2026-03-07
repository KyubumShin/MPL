#!/usr/bin/env node
/**
 * MPL Write Guard Hook (PreToolUse)
 * Blocks orchestrator from directly editing source files when MPL is active.
 * Source file edits must be delegated to mpl-worker agents.
 *
 * Based on: design doc section 9.2 hook 1 + OMC pre-tool-use.mjs pattern
 *
 * When MPL is inactive: does nothing (no interference with normal workflow)
 * When MPL is active: blocks Edit/Write on source files, allows config/state paths
 */

import { dirname, join, extname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import shared MPL state utility
const { isMplActive } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);

// Import shared stdin reader
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);

// Allowed path patterns (orchestrator CAN write to these)
const ALLOWED_PATTERNS = [
  /\.mpl\//,           // .mpl/ state directory
  /\.omc\//,           // .omc/ OMC state
  /\.claude\//,        // .claude/ config
  /\/\.claude\//,      // absolute .claude/ paths
  /\/MPL\//,           // MPL/ plugin directory
  /PLAN\.md$/,         // PLAN.md (orchestrator manages checkboxes)
  /docs\/learnings\//, // learnings directory
];

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

function isAllowedPath(filePath) {
  if (!filePath) return true;
  return ALLOWED_PATTERNS.some(pattern => pattern.test(filePath));
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

  // Only intercept Edit and Write tools
  if (!['Edit', 'Write', 'edit', 'write'].includes(toolName)) {
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

  // Extract file path
  const toolInput = data.tool_input || data.toolInput || {};
  const filePath = toolInput.file_path || toolInput.filePath || '';

  if (!filePath) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Check if path is allowed for orchestrator
  if (isAllowedPath(filePath)) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Check if it's a source file
  if (isSourceFile(filePath)) {
    // BLOCK: source files must be edited by worker agents
    const message = `[MPL WRITE GUARD] Blocked: ${toolName} on ${filePath}

Source files must be edited by mpl-worker agents, not the orchestrator.
Delegate via: Task(subagent_type="mpl-worker", prompt="Edit ${filePath} to ...")

This is a HARD block. The operation will not proceed.`;

    console.log(JSON.stringify({
      continue: false,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: message
      }
    }));
    return;
  }

  // Not a source file, not in allowed paths: allow with warning
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

main().catch(() => {
  // On error: allow (fail-open for safety)
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
});

export { isAllowedPath, isSourceFile };
