/**
 * MPL Test Analyzer — API Contract Auto-Extraction
 *
 * Extracts API contracts from test files by analyzing:
 * - Function/method calls (name, arguments, keyword args)
 * - pytest.raises blocks (exception type, match pattern)
 * - assert statements (expected values, comparison operators)
 * - Fixture usage (fixture names, dependencies)
 *
 * Uses regex-based parsing (no external AST dependency required).
 * For deeper analysis, the orchestrator can use ast_grep_search/lsp tools.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, basename, extname } from 'path';

/**
 * @typedef {object} FunctionCall
 * @property {string} name - Function/method name
 * @property {number} argCount - Number of positional arguments
 * @property {string[]} kwargs - Keyword argument names
 * @property {number} line - Line number
 */

/**
 * @typedef {object} ExceptionSpec
 * @property {string} exceptionType - Exception class name
 * @property {string|null} matchPattern - match= regex pattern
 * @property {number} line - Line number
 */

/**
 * @typedef {object} AssertInfo
 * @property {string} assertion - Full assert expression (truncated)
 * @property {string} operator - Comparison operator (==, !=, in, is, etc.)
 * @property {number} line - Line number
 */

/**
 * @typedef {object} FixtureInfo
 * @property {string} name - Fixture name
 * @property {string[]} params - Fixture parameters (dependencies)
 * @property {number} line - Line number
 */

/**
 * @typedef {object} APIContracts
 * @property {string} file - Source file path
 * @property {FunctionCall[]} calls - Extracted function calls
 * @property {ExceptionSpec[]} exceptions - Extracted exception specs
 * @property {AssertInfo[]} asserts - Extracted assertions
 * @property {FixtureInfo[]} fixtures - Extracted fixtures
 */

// Patterns
const FUNCTION_CALL_RE = /(\w[\w.]*)\s*\(([^)]*)\)/g;
const PYTEST_RAISES_RE = /pytest\.raises\(\s*(\w+)(?:\s*,\s*match\s*=\s*(?:r?["'](.+?)["']|(\w+)))?\s*\)/g;
const ASSERT_RE = /^\s*assert\s+(.+)/gm;
const FIXTURE_RE = /@pytest\.fixture(?:\(([^)]*)\))?\s*\ndef\s+(\w+)\(([^)]*)\)/g;
const DEF_TEST_RE = /^def\s+(test_\w+)\(([^)]*)\)/gm;

/**
 * Analyze a single test file for API contracts.
 *
 * @param {string} filePath - Path to test file
 * @returns {APIContracts} Extracted contracts
 */
export function analyzeFile(filePath) {
  if (!existsSync(filePath)) {
    return { file: filePath, calls: [], exceptions: [], asserts: [], fixtures: [] };
  }

  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  return {
    file: filePath,
    calls: extractFunctionCalls(content, lines),
    exceptions: extractExceptions(content),
    asserts: extractAsserts(content),
    fixtures: extractFixtures(content),
  };
}

/**
 * Analyze all test files in a directory.
 *
 * @param {string} dirPath - Path to test directory
 * @param {string} [pattern='test_'] - Filename prefix filter
 * @returns {APIContracts[]} Array of contracts per file
 */
export function analyzeDirectory(dirPath, pattern = 'test_') {
  if (!existsSync(dirPath)) return [];

  const files = readdirSync(dirPath)
    .filter(f => f.startsWith(pattern) && extname(f) === '.py')
    .map(f => join(dirPath, f));

  return files.map(f => analyzeFile(f));
}

/**
 * Extract function/method calls from content.
 */
function extractFunctionCalls(content, lines) {
  const calls = [];
  const seen = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comments and decorators
    if (line.trim().startsWith('#') || line.trim().startsWith('@')) continue;

    let match;
    const lineRe = /(\w[\w.]*)\s*\(([^)]*)\)/g;
    while ((match = lineRe.exec(line)) !== null) {
      const name = match[1];
      const argsStr = match[2].trim();

      // Skip common non-API calls
      if (['print', 'len', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple',
           'range', 'type', 'isinstance', 'hasattr', 'getattr', 'setattr',
           'pytest.raises', 'pytest.fixture', 'pytest.mark'].some(skip => name === skip || name.startsWith('pytest.'))) {
        continue;
      }

      const args = argsStr ? argsStr.split(',').map(a => a.trim()).filter(Boolean) : [];
      const kwargs = args.filter(a => a.includes('=')).map(a => a.split('=')[0].trim());
      const positionalCount = args.length - kwargs.length;

      const key = `${name}:${positionalCount}:${kwargs.sort().join(',')}`;
      if (!seen.has(key)) {
        seen.add(key);
        calls.push({ name, argCount: positionalCount, kwargs, line: i + 1 });
      }
    }
  }

  return calls;
}

/**
 * Extract pytest.raises exception specs.
 */
function extractExceptions(content) {
  const exceptions = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const re = /pytest\.raises\(\s*(\w+)(?:\s*,\s*match\s*=\s*(?:r?["'](.+?)["']|(\w+)))?\s*\)/g;
    let match;
    while ((match = re.exec(line)) !== null) {
      exceptions.push({
        exceptionType: match[1],
        matchPattern: match[2] || match[3] || null,
        line: i + 1,
      });
    }
  }

  return exceptions;
}

/**
 * Extract assert statements.
 */
function extractAsserts(content) {
  const asserts = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('assert ')) continue;

    const expr = line.slice(7).trim();
    let operator = '==';
    if (expr.includes(' == ')) operator = '==';
    else if (expr.includes(' != ')) operator = '!=';
    else if (expr.includes(' is not ')) operator = 'is not';
    else if (expr.includes(' is ')) operator = 'is';
    else if (expr.includes(' in ')) operator = 'in';
    else if (expr.includes(' not in ')) operator = 'not in';
    else if (expr.includes(' >= ')) operator = '>=';
    else if (expr.includes(' <= ')) operator = '<=';
    else if (expr.includes(' > ')) operator = '>';
    else if (expr.includes(' < ')) operator = '<';
    else operator = 'truthy';

    asserts.push({
      assertion: expr.length > 120 ? expr.slice(0, 120) + '...' : expr,
      operator,
      line: i + 1,
    });
  }

  return asserts;
}

/**
 * Extract pytest fixtures.
 */
function extractFixtures(content) {
  const fixtures = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('@pytest.fixture')) continue;

    // Look for the def line (may be next line or after decorator args)
    for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
      const defMatch = lines[j].match(/^def\s+(\w+)\(([^)]*)\)/);
      if (defMatch) {
        const params = defMatch[2].trim()
          ? defMatch[2].split(',').map(p => p.trim()).filter(Boolean)
          : [];
        fixtures.push({ name: defMatch[1], params, line: j + 1 });
        break;
      }
    }
  }

  return fixtures;
}

/**
 * Generate API contracts markdown from analysis results.
 *
 * @param {APIContracts[]} contracts - Array of per-file contracts
 * @returns {string} Markdown content
 */
export function generateContractsMd(contracts) {
  const lines = ['# API Contract Specification (Auto-Generated)', ''];

  for (const contract of contracts) {
    if (contract.calls.length === 0 && contract.exceptions.length === 0 &&
        contract.asserts.length === 0 && contract.fixtures.length === 0) {
      continue;
    }

    lines.push(`## ${basename(contract.file)}`, '');

    if (contract.calls.length > 0) {
      lines.push('### Function Calls', '');
      lines.push('| Function | Positional Args | Keyword Args | Line |');
      lines.push('|----------|----------------|--------------|------|');
      for (const c of contract.calls) {
        lines.push(`| \`${c.name}\` | ${c.argCount} | ${c.kwargs.join(', ') || '-'} | ${c.line} |`);
      }
      lines.push('');
    }

    if (contract.exceptions.length > 0) {
      lines.push('### Exception Specifications', '');
      lines.push('| Exception | Match Pattern | Line |');
      lines.push('|-----------|--------------|------|');
      for (const e of contract.exceptions) {
        lines.push(`| \`${e.exceptionType}\` | ${e.matchPattern ? `\`${e.matchPattern}\`` : '-'} | ${e.line} |`);
      }
      lines.push('');
    }

    if (contract.fixtures.length > 0) {
      lines.push('### Fixtures', '');
      lines.push('| Fixture | Dependencies | Line |');
      lines.push('|---------|-------------|------|');
      for (const f of contract.fixtures) {
        lines.push(`| \`${f.name}\` | ${f.params.join(', ') || '-'} | ${f.line} |`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}
