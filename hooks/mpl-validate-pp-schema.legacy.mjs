#!/usr/bin/env node
/**
 * MPL Validate PP Schema Hook (PreToolUse on Write|Edit|MultiEdit)
 *
 * Guards `.mpl/pivot-points.md` (immutable PP file) from UC-scoped schema
 * leakage. Pivot Points are design invariants; User Cases are mutable feature
 * scope. They MUST live in separate files.
 *
 *   - pivot-points.md               → PP (immutable)
 *   - requirements/user-contract.md → UC (mutable, 0.16 Tier A')
 *
 * If a Write, Edit, or MultiEdit targets pivot-points.md and the proposed
 * content contains UC-specific schema keys or UC-N identifiers, the hook blocks
 * the write.
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

const { collectFileWrites, isFileWriteTool } = await import(
  pathToFileURL(join(__dirname, 'lib', 'tool-input.mjs')).href
);

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
  if (!isFileWriteTool(toolName)) return '';
  return collectFileWrites(toolInput)
    .map((entry) => entry.text)
    .filter(Boolean)
    .join('\n');
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
  const { emitBlockedHook, emitClearedOk } = await import(
    pathToFileURL(join(__dirname, 'lib', 'mpl-block-surface.mjs')).href
  );
  const { readState, isMplActive } = await import(
    pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
  );

  const HOOK_ID = 'mpl-validate-pp-schema';
  const BLOCKED_ARTIFACT = '.mpl/pivot-points.md';

  const ok = () =>
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));

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
      const toolName = input.tool_name || input.toolName || '';
      if (!isFileWriteTool(toolName)) ok();
      else {
        const toolInput = input.tool_input || {};
        const entries = collectFileWrites(toolInput)
          .filter((entry) => targetsPivotPointsFile(entry.filePath));
        if (entries.length === 0) ok();
        else {
          const content = entries.map((entry) => entry.text).filter(Boolean).join('\n');
          if (!content) ok();
          else {
            const hits = detectUcLeakage(content);
            const cwd = input.cwd || input.directory || process.cwd();
            if (hits.length === 0) {
              if (isMplActive(cwd)) {
                emitClearedOk(cwd, { hookId: HOOK_ID, artifact: BLOCKED_ARTIFACT });
              } else {
                ok();
              }
            } else {
              if (!isMplActive(cwd)) {
                // Pre-MPL workspaces — preserve original behavior.
                console.log(JSON.stringify({
                  continue: false,
                  decision: 'block',
                  reason: formatBlockReason(hits),
                }));
              } else {
                const state = readState(cwd) || {};
                emitBlockedHook(cwd, state, {
                  hookId: HOOK_ID,
                  ruleId: 'pp_schema_invalid',
                  code: 'pp_schema_uc_leakage',
                  artifact: BLOCKED_ARTIFACT,
                  reason: formatBlockReason(hits),
                  resumeInstruction:
                    'Move every UC-scoped schema key out of .mpl/pivot-points.md into .mpl/requirements/user-contract.md, then retry the write.',
                  retryContext: { markers: hits.map((h) => h.name) },
                });
              }
            }
          }
        }
      }
    }
  } catch {
    ok();
  }
}
