#!/usr/bin/env node
/**
 * MPL Soft-Signal Emitter (PreToolUse: Task|Agent)
 *
 * Emits quality-signal telemetry records for prompt-only quality rules
 * that should never block but should be countable across runs.
 *
 * Currently surfaces:
 *   - HA-01: vague delegation prompt
 *     (e.g. "이전 결과 참고", "알아서 판단", "use your judgement")
 *     Detected on every Task/Agent invocation that carries a prompt.
 *
 * Append-only sink: `.mpl/mpl/quality-signals.jsonl`. Surfaced in
 * `mpl-doctor` Category 16. NEVER blocks (continue: true always).
 *
 * See:
 *   - Issue #238
 *   - `docs/findings/2026-05-28-enforcement-relaxation-plan.md` §A2
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
const { detectHa01, recordQualitySignal } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-quality-signals.mjs')).href
);

async function main() {
  const input = await readStdin();

  let data;
  try {
    data = JSON.parse(input);
  } catch {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const cwd = data.cwd || data.directory || process.cwd();
  if (!isMplActive(cwd)) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  // Codex r2 [contract-break]: sibling hooks (`mpl-validate-seed`,
  // `mpl-ambiguity-gate`, etc.) accept both snake_case AND camelCase
  // payload shapes. Reading only `data.tool_name` would silently drop
  // HA-01 signals when the harness delivers `toolName` / `toolInput`,
  // breaking the doctor count.
  const toolName = data.tool_name || data.toolName || '';
  if (toolName !== 'Task' && toolName !== 'Agent') {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const toolInput = data.tool_input || data.toolInput || {};
  const subagentType = toolInput.subagent_type || toolInput.subagentType || '';
  const prompt = toolInput.prompt || toolInput.description || '';

  const ha01 = detectHa01(prompt);
  if (ha01) {
    recordQualitySignal(
      {
        rule: 'HA-01',
        severity: 'warn',
        agent: subagentType || toolName,
        evidence: {
          matched_phrase: ha01.phrase,
          offset: ha01.offset,
          prompt_preview: prompt.slice(Math.max(0, ha01.offset - 40), ha01.offset + 80),
        },
      },
      cwd,
    );
  }

  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  main().catch(() => {
    // Fail-soft: never block on telemetry IO.
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  });
}
