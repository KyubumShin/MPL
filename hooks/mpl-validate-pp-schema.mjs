#!/usr/bin/env node
/**
 * MPL Validate PP Schema Hook (PreToolUse on Write|Edit)
 *
 * Guards `.mpl/pivot-points.md` (immutable PP file) from UC-scoped schema
 * leakage. Pivot Points are design invariants; User Cases are mutable feature
 * scope. They MUST live in separate files.
 *
 *   - pivot-points.md               → PP (immutable)
 *   - requirements/user-contract.md → UC (mutable, 0.16 Tier A')
 *
 * If a Write or Edit targets pivot-points.md and the proposed content contains
 * UC-specific schema keys or UC-N identifiers, the hook blocks the write.
 *
 * This is the reverse of common drift: during interviews or fix loops the
 * orchestrator may mistakenly try to persist UC discoveries into the PP file.
 * The hook is the structural guard.
 *
 * Non-blocking on any error.
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const UC_SCHEMA_PATTERNS = [
  { re: /^user_cases\s*:/m, name: 'user_cases:' },
  { re: /^deferred_cases\s*:/m, name: 'deferred_cases:' },
  { re: /^cut_cases\s*:/m, name: 'cut_cases:' },
  { re: /^\s{2,}user_delta\s*:/m, name: 'user_delta:' },
  { re: /^\s{2,}covers_pp\s*:/m, name: 'covers_pp:' },
  { re: /\bUC-\d{2,}\b/, name: 'UC-NN identifier' },
];

export function targetsPivotPointsFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  return /(^|\/)\.mpl\/pivot-points\.md$/.test(filePath);
}

export function extractProposedContent(toolInput, toolName) {
  if (!toolInput) return '';
  if (toolName === 'Write') return toolInput.content || '';
  if (toolName === 'Edit') return toolInput.new_string || '';
  return '';
}

export function detectUcLeakage(content) {
  if (!content || typeof content !== 'string') return [];
  return UC_SCHEMA_PATTERNS.filter((p) => p.re.test(content));
}

export function formatBlockReason(hits) {
  const names = hits.map((h) => h.name).join(', ');
  return [
    `Blocked: .mpl/pivot-points.md (immutable PP file) must not contain UC-scoped schema.`,
    `Detected markers: ${names}.`,
    `UCs belong in .mpl/requirements/user-contract.md (0.16 Tier A').`,
    `If you are trying to persist user feature discoveries, write them to the user-contract file instead.`,
  ].join(' ');
}

// Skip execution during tests (when imported as a module)
const isMain =
  import.meta.url === pathToFileURL(process.argv[1] || '').href;

if (isMain) {
  const { readStdin } = await import(
    pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
  );

  const ok = () =>
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  const block = (reason) =>
    console.log(JSON.stringify({ continue: false, decision: 'block', reason }));

  try {
    const raw = await readStdin();
    if (!raw) ok();
    else {
      let input;
      try {
        input = JSON.parse(raw);
      } catch {
        ok();
        process.exit(0);
      }
      const toolName = input.tool_name || '';
      if (toolName !== 'Write' && toolName !== 'Edit') ok();
      else {
        const toolInput = input.tool_input || {};
        const target = toolInput.file_path || '';
        if (!targetsPivotPointsFile(target)) ok();
        else {
          const content = extractProposedContent(toolInput, toolName);
          if (!content) ok();
          else {
            const hits = detectUcLeakage(content);
            if (hits.length === 0) ok();
            else block(formatBlockReason(hits));
          }
        }
      }
    }
  } catch {
    ok();
  }
}
