#!/usr/bin/env node
/**
 * MPL Sentinel S3 — Test Import Path Validator (PostToolUse)
 *
 * Validates that Test Agent's import paths resolve to real files.
 * Runs after Test Agent completes to catch broken imports before Gate execution.
 *
 * Checks import/from statements in test files, resolves relative paths,
 * and verifies target files exist with common extension fallbacks.
 */

import { dirname, join, resolve, extname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';

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

/**
 * Common extensions to try when resolving import paths without extensions.
 */
const RESOLVE_EXTENSIONS = ['.ts', '.js', '.tsx', '.jsx', '.mjs', '.cjs'];

/**
 * Patterns to detect test files by name.
 */
const TEST_FILE_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /test_.*\.py$/,
  /.*_test\.py$/,
  /.*_test\.go$/,
  /.*_test\.rs$/,
  /__tests__\//,
];

/**
 * Regex patterns for extracting import paths from source code.
 * Captures the module specifier from import/from statements.
 */
const IMPORT_PATTERNS = [
  // ES import: import X from './path'  or  import './path'
  /\bimport\s+(?:(?:[\w{},*\s]+)\s+from\s+)?['"]([^'"]+)['"]/g,
  // Dynamic import: import('./path')
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  // CommonJS require: require('./path')
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  // Python import: from .path import X  (relative only)
  /\bfrom\s+(\.[\w.]*)\s+import\b/g,
];

/**
 * Check if a file is a test file based on its name.
 * @param {string} fileName
 * @returns {boolean}
 */
export function isTestFile(fileName) {
  return TEST_FILE_PATTERNS.some(p => p.test(fileName));
}

/**
 * Extract import paths from file content.
 * Only returns relative paths (starting with . or ..) since package imports
 * cannot be resolved with filesystem checks alone.
 * @param {string} content - File content
 * @returns {string[]} Array of relative import paths
 */
export function extractImportPaths(content) {
  const paths = new Set();

  for (const pattern of IMPORT_PATTERNS) {
    // Reset lastIndex for global regex
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const importPath = match[1];
      // Only check relative imports (. or ..)
      if (importPath.startsWith('.')) {
        paths.add(importPath);
      }
    }
  }

  return [...paths];
}

/**
 * Resolve an import path to an actual file path.
 * Tries the path as-is, then with common extensions, then as directory/index.
 * @param {string} importPath - The import specifier (relative)
 * @param {string} fromDir - Directory of the importing file
 * @returns {string|null} Resolved absolute path, or null if not found
 */
export function resolveImportPath(importPath, fromDir) {
  const basePath = resolve(fromDir, importPath);

  // 1. Try exact path
  if (existsSync(basePath) && isFile(basePath)) {
    return basePath;
  }

  // 2. Try with extensions
  for (const ext of RESOLVE_EXTENSIONS) {
    const withExt = basePath + ext;
    if (existsSync(withExt) && isFile(withExt)) {
      return withExt;
    }
  }

  // 3. Try as directory with index file
  if (existsSync(basePath) && isDirectory(basePath)) {
    for (const ext of RESOLVE_EXTENSIONS) {
      const indexPath = join(basePath, `index${ext}`);
      if (existsSync(indexPath)) {
        return indexPath;
      }
    }
  }

  return null;
}

/**
 * Check if path is a file (not directory).
 * @param {string} filePath
 * @returns {boolean}
 */
function isFile(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Check if path is a directory.
 * @param {string} filePath
 * @returns {boolean}
 */
function isDirectory(filePath) {
  try {
    return statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Find test files in phase directories.
 * Scans .mpl/mpl/phases/{phase_id}/ for test files.
 * @param {string} cwd - Working directory
 * @returns {string[]} Absolute paths to test files
 */
export function findTestFiles(cwd) {
  const phasesDir = join(cwd, '.mpl', 'mpl', 'phases');
  if (!existsSync(phasesDir)) return [];

  const testFiles = [];
  try {
    const phaseEntries = readdirSync(phasesDir, { withFileTypes: true });
    for (const phaseEntry of phaseEntries) {
      if (!phaseEntry.isDirectory()) continue;
      const phaseDir = join(phasesDir, phaseEntry.name);
      collectTestFiles(phaseDir, testFiles);
    }
  } catch {
    // Directory read failure
  }
  return testFiles;
}

/**
 * Recursively collect test files from a directory (max depth 3).
 * @param {string} dir - Directory to scan
 * @param {string[]} results - Accumulator for found test files
 * @param {number} depth - Current recursion depth
 */
function collectTestFiles(dir, results, depth = 0) {
  if (depth > 3) return; // Prevent deep recursion

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isFile() && isTestFile(entry.name)) {
        results.push(fullPath);
      } else if (entry.isDirectory() && depth < 3) {
        collectTestFiles(fullPath, results, depth + 1);
      }
    }
  } catch {
    // Read failure: skip
  }
}

/**
 * Validate all import paths in a test file.
 * @param {string} testFilePath - Absolute path to the test file
 * @returns {{ file: string, invalid: Array<{ importPath: string, resolvedAttempt: string }> }}
 */
export function validateTestImports(testFilePath) {
  const invalid = [];

  let content;
  try {
    content = readFileSync(testFilePath, 'utf-8');
  } catch {
    return { file: testFilePath, invalid: [{ importPath: '<unreadable>', resolvedAttempt: testFilePath }] };
  }

  const importPaths = extractImportPaths(content);
  const fromDir = dirname(testFilePath);

  for (const importPath of importPaths) {
    const resolved = resolveImportPath(importPath, fromDir);
    if (!resolved) {
      const attempted = resolve(fromDir, importPath);
      invalid.push({ importPath, resolvedAttempt: attempted });
    }
  }

  return { file: testFilePath, invalid };
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

  // Only intercept Task/Agent tool completions
  if (!['Task', 'task', 'Agent', 'agent'].includes(toolName)) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Check if MPL is active
  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Find test files in phase directories
  const testFiles = findTestFiles(cwd);

  // Skip if no test files found
  if (testFiles.length === 0) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Validate imports in all test files
  const allInvalid = [];
  for (const testFile of testFiles) {
    const { file, invalid } = validateTestImports(testFile);
    if (invalid.length > 0) {
      allInvalid.push({ file, invalid });
    }
  }

  if (allInvalid.length === 0) {
    // All imports resolve
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Validation failed: output system-reminder with invalid imports
  const errorLines = [];
  for (const { file, invalid } of allInvalid) {
    errorLines.push(`  ${file}:`);
    for (const { importPath, resolvedAttempt } of invalid) {
      errorLines.push(`    - import "${importPath}" -> not found (tried: ${resolvedAttempt})`);
    }
  }

  const message = `[MPL SENTINEL S3] Test import path validation failed.

The following test file imports could not be resolved to existing files:
${errorLines.join('\n')}

ACTION REQUIRED: Fix broken import paths in test files before running Gate checks.
Verify that the imported modules exist and paths are correct relative to the test file location.`;

  console.log(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: message
    }
  }));
}

main().catch(() => {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
});
