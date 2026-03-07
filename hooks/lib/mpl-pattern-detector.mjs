/**
 * MPL Pattern Detector — 7-Category Auto-Classification
 *
 * Detects usage patterns in test files and classifies them into 7 categories:
 * 1. Creation patterns (object instantiation)
 * 2. Validation patterns (assert statements + comparisons)
 * 3. Error patterns (pytest.raises blocks)
 * 4. Ordering patterns (sorted(), list comparison)
 * 5. Side-effect patterns (state mutation after action)
 * 6. Default patterns (fixture defaults, default parameters)
 * 7. Integration patterns (multi-module imports)
 *
 * Uses regex-based detection. No external dependencies required.
 */

import { existsSync, readFileSync } from 'fs';
import { basename } from 'path';

/**
 * @typedef {object} Pattern
 * @property {string} category - One of the 7 categories
 * @property {string} description - Human-readable description
 * @property {string} code - Code snippet (truncated)
 * @property {number} line - Line number
 */

const CATEGORIES = {
  CREATION: 'creation',
  VALIDATION: 'validation',
  ERROR: 'error',
  ORDERING: 'ordering',
  SIDE_EFFECT: 'side_effect',
  DEFAULT: 'default',
  INTEGRATION: 'integration',
};

/**
 * Detect all patterns in a test file.
 *
 * @param {string} filePath - Path to test file
 * @returns {{ file: string, patterns: Pattern[], summary: object }}
 */
export function detectPatterns(filePath) {
  if (!existsSync(filePath)) {
    return { file: filePath, patterns: [], summary: {} };
  }

  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  const patterns = [
    ...detectCreation(lines),
    ...detectValidation(lines),
    ...detectError(lines),
    ...detectOrdering(lines),
    ...detectSideEffect(lines),
    ...detectDefault(lines, content),
    ...detectIntegration(lines),
  ];

  // Summary: count per category
  const summary = {};
  for (const cat of Object.values(CATEGORIES)) {
    summary[cat] = patterns.filter(p => p.category === cat).length;
  }

  return { file: filePath, patterns, summary };
}

/**
 * 1. Creation patterns — class instantiation, factory calls
 */
function detectCreation(lines) {
  const patterns = [];
  const creationRe = /(\w+)\s*=\s*([A-Z]\w+)\s*\(/;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(creationRe);
    if (match) {
      patterns.push({
        category: CATEGORIES.CREATION,
        description: `${match[2]} instantiation → ${match[1]}`,
        code: lines[i].trim().slice(0, 100),
        line: i + 1,
      });
    }
  }
  return patterns;
}

/**
 * 2. Validation patterns — assert with comparison operators
 */
function detectValidation(lines) {
  const patterns = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith('assert ')) continue;

    const expr = trimmed.slice(7);
    let type = 'boolean check';
    if (expr.includes(' == ')) type = 'equality';
    else if (expr.includes(' != ')) type = 'inequality';
    else if (expr.includes(' is ')) type = 'identity';
    else if (expr.includes(' in ')) type = 'membership';
    else if (expr.includes(' >= ') || expr.includes(' <= ') || expr.includes(' > ') || expr.includes(' < ')) type = 'comparison';

    patterns.push({
      category: CATEGORIES.VALIDATION,
      description: `${type} assertion`,
      code: trimmed.slice(0, 100),
      line: i + 1,
    });
  }
  return patterns;
}

/**
 * 3. Error patterns — pytest.raises blocks
 */
function detectError(lines) {
  const patterns = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/pytest\.raises\(\s*(\w+)(?:\s*,\s*match\s*=\s*(?:r?["'](.+?)["']))?\s*\)/);
    if (match) {
      const desc = match[2]
        ? `${match[1]} with match pattern "${match[2]}"`
        : `${match[1]} expected`;
      patterns.push({
        category: CATEGORIES.ERROR,
        description: desc,
        code: lines[i].trim().slice(0, 100),
        line: i + 1,
      });
    }
  }
  return patterns;
}

/**
 * 4. Ordering patterns — sorted(), list equality with ordered data
 */
function detectOrdering(lines) {
  const patterns = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    if (trimmed.includes('sorted(')) {
      patterns.push({
        category: CATEGORIES.ORDERING,
        description: 'sorted() usage — ordering requirement',
        code: trimmed.slice(0, 100),
        line: i + 1,
      });
    } else if (trimmed.match(/assert\s+.*\[\s*["'].*["']\s*,/) && trimmed.includes('==')) {
      patterns.push({
        category: CATEGORIES.ORDERING,
        description: 'list comparison — ordered elements',
        code: trimmed.slice(0, 100),
        line: i + 1,
      });
    }
  }
  return patterns;
}

/**
 * 5. Side-effect patterns — state check after method call
 */
function detectSideEffect(lines) {
  const patterns = [];

  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1].trim();
    const curr = lines[i].trim();

    // Pattern: method call on previous line, assert on attribute on current line
    if (prev.match(/\w+\.\w+\(/) && !prev.startsWith('assert') && !prev.startsWith('#') &&
        curr.startsWith('assert ') && curr.match(/\.\w+/)) {
      patterns.push({
        category: CATEGORIES.SIDE_EFFECT,
        description: 'state check after method call',
        code: `${prev} → ${curr}`.slice(0, 100),
        line: i + 1,
      });
    }
  }
  return patterns;
}

/**
 * 6. Default patterns — fixture defaults, default parameter values
 */
function detectDefault(lines, content) {
  const patterns = [];

  // Fixture with default values
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('@pytest.fixture')) {
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const defMatch = lines[j].match(/def\s+\w+\(/);
        if (defMatch) {
          // Look for return with dict/object containing defaults
          for (let k = j + 1; k < Math.min(j + 10, lines.length); k++) {
            if (lines[k].match(/return\s+/) || lines[k].match(/["']\w+["']\s*:/)) {
              patterns.push({
                category: CATEGORIES.DEFAULT,
                description: 'fixture providing default values',
                code: lines[k].trim().slice(0, 100),
                line: k + 1,
              });
              break;
            }
          }
          break;
        }
      }
    }

    // Default parameter values in function calls
    const defaultParam = lines[i].match(/(\w+)\s*=\s*(?:["']\w+["']|\d+|True|False|None)\s*[,)]/);
    if (defaultParam && !lines[i].trim().startsWith('#') && !lines[i].trim().startsWith('assert')) {
      patterns.push({
        category: CATEGORIES.DEFAULT,
        description: `default value for "${defaultParam[1]}"`,
        code: lines[i].trim().slice(0, 100),
        line: i + 1,
      });
    }
  }
  return patterns;
}

/**
 * 7. Integration patterns — multi-module imports
 */
function detectIntegration(lines) {
  const patterns = [];
  const imports = [];

  for (let i = 0; i < lines.length; i++) {
    const importMatch = lines[i].match(/^(?:from\s+(\S+)\s+import|import\s+(\S+))/);
    if (importMatch) {
      const module = importMatch[1] || importMatch[2];
      if (!module.startsWith('pytest') && !module.startsWith('os') &&
          !module.startsWith('sys') && !module.startsWith('json') &&
          !module.startsWith('pathlib') && !module.startsWith('unittest') &&
          !module.startsWith('typing') && !module.startsWith('collections') &&
          !module.startsWith('datetime') && !module.startsWith('re') &&
          !module.startsWith('tempfile') && !module.startsWith('io')) {
        imports.push({ module, line: i + 1 });
      }
    }
  }

  if (imports.length >= 2) {
    patterns.push({
      category: CATEGORIES.INTEGRATION,
      description: `multi-module integration: ${imports.map(i => i.module).join(', ')}`,
      code: imports.map(i => `import ${i.module}`).join('; ').slice(0, 100),
      line: imports[0].line,
    });
  }

  return patterns;
}

/**
 * Generate examples.md from detected patterns.
 *
 * @param {{ file: string, patterns: Pattern[], summary: object }[]} results
 * @returns {string} Markdown content
 */
export function generateExamplesMd(results) {
  const lines = ['# Example Pattern Analysis (Auto-Generated)', ''];

  // Aggregate all patterns by category
  const byCategory = {};
  for (const cat of Object.values(CATEGORIES)) {
    byCategory[cat] = [];
  }
  for (const result of results) {
    for (const p of result.patterns) {
      byCategory[p.category].push({ ...p, file: basename(result.file) });
    }
  }

  const categoryNames = {
    [CATEGORIES.CREATION]: 'Creation Patterns (Object Instantiation)',
    [CATEGORIES.VALIDATION]: 'Validation Patterns (Assertions)',
    [CATEGORIES.ERROR]: 'Error Patterns (Exception Handling)',
    [CATEGORIES.ORDERING]: 'Ordering Patterns (Sorting/Ordering)',
    [CATEGORIES.SIDE_EFFECT]: 'Side-Effect Patterns (State Mutation)',
    [CATEGORIES.DEFAULT]: 'Default Patterns (Default Values)',
    [CATEGORIES.INTEGRATION]: 'Integration Patterns (Multi-Module)',
  };

  const priorityOrder = [
    CATEGORIES.CREATION, CATEGORIES.VALIDATION, CATEGORIES.ERROR,
    CATEGORIES.ORDERING, CATEGORIES.SIDE_EFFECT,
    CATEGORIES.DEFAULT, CATEGORIES.INTEGRATION,
  ];

  for (const cat of priorityOrder) {
    const patterns = byCategory[cat];
    if (patterns.length === 0) continue;

    lines.push(`## ${categoryNames[cat]} (${patterns.length})`, '');
    for (const p of patterns.slice(0, 10)) { // Limit to 10 per category
      lines.push(`- **${p.description}** (${p.file}:${p.line})`);
      lines.push(`  \`${p.code}\``);
    }
    if (patterns.length > 10) {
      lines.push(`- ... and ${patterns.length - 10} more`);
    }
    lines.push('');
  }

  // Summary table
  lines.push('## Summary', '');
  lines.push('| Category | Count | Priority |');
  lines.push('|----------|-------|----------|');
  const priorities = {
    [CATEGORIES.CREATION]: 'High', [CATEGORIES.VALIDATION]: 'High', [CATEGORIES.ERROR]: 'High',
    [CATEGORIES.ORDERING]: 'Medium', [CATEGORIES.SIDE_EFFECT]: 'Medium',
    [CATEGORIES.DEFAULT]: 'Low', [CATEGORIES.INTEGRATION]: 'Low',
  };
  for (const cat of priorityOrder) {
    const count = byCategory[cat].length;
    if (count > 0) {
      lines.push(`| ${categoryNames[cat].split('(')[0].trim()} | ${count} | ${priorities[cat]} |`);
    }
  }

  return lines.join('\n');
}
