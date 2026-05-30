#!/usr/bin/env node
/**
 * MPL Finalize Gate (PreToolUse on Write|Edit|MultiEdit targeting state.json).
 *
 * Coalesces the four finalize_done validators (#257):
 *   - mpl-require-e2e               — declared E2E scenarios ran + exited 0
 *   - mpl-require-e2e-authenticity  — real runtime, no mocks, no placeholder
 *   - mpl-require-finalize-artifacts — goal-contract declared evidence present
 *   - mpl-require-whole-goal-closure — AC/AX coverage across completed phases
 *
 * The four hooks individually verify distinct properties, but registering them
 * separately produced a cascading-block UX: fix one, retry, hit the next.
 * This gate runs them as delegated subprocesses, captures each violation, and
 * emits a SINGLE coalesced envelope listing every failure together so the user
 * can fix them in one batch.
 *
 * Per-rule ENFORCEMENT_DEFAULTS (off/warn/block) are preserved — each child
 * resolves its own rule action independently. Only child responses whose
 * decision === 'block' contribute to failures[]; warn responses contribute to
 * advisories[]. A child resolving to off contributes nothing.
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { spawnSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;

const { readState, isMplActive } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);
const { readStdin } = isMain
  ? await import(pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href)
  : { readStdin: async () => '' };
const { emitBlockedHook, emitClearedOk } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-block-surface.mjs')).href
);
const { clearBlockedHook } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-blocked-hook.mjs')).href
);

const HOOK_ID = 'mpl-finalize-gate';
const BLOCKED_ARTIFACT = '.mpl/state.json#finalize_done';

const DELEGATES = [
  'mpl-require-e2e.mjs',
  'mpl-require-e2e-authenticity.mjs',
  'mpl-require-finalize-artifacts.mjs',
  'mpl-require-whole-goal-closure.mjs',
];

const ENV_GUARD_KEY = 'MPL_FINALIZE_GATE_ACTIVE';

function ok() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

function isFinalizeDoneWrite(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return false;
  const paths = [];
  if (toolInput.file_path) paths.push(toolInput.file_path);
  if (toolInput.filePath) paths.push(toolInput.filePath);
  const texts = [];
  for (const key of ['new_string', 'newString', 'content']) {
    if (typeof toolInput[key] === 'string') texts.push(toolInput[key]);
  }
  if (Array.isArray(toolInput.edits)) {
    for (const edit of toolInput.edits) {
      if (edit?.file_path) paths.push(edit.file_path);
      if (edit?.filePath) paths.push(edit.filePath);
      for (const key of ['new_string', 'newString', 'content']) {
        if (typeof edit?.[key] === 'string') texts.push(edit[key]);
      }
    }
  }
  if (!paths.some((p) => /(^|\/)\.mpl\/state\.json$/.test(p))) return false;
  return texts.some((text) => /"finalize_done"\s*:\s*true/.test(text));
}

function parseLastJsonLine(stdout) {
  if (!stdout) return null;
  const lines = stdout.trim().split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function delegateChild(hookFile, stdinPayload, cwd) {
  const hookPath = join(__dirname, hookFile);
  const hookId = hookFile.replace(/\.mjs$/, '');
  const env = { ...process.env, [ENV_GUARD_KEY]: '1' };

  let result;
  try {
    result = spawnSync('node', [hookPath], {
      input: stdinPayload,
      encoding: 'utf-8',
      env,
      timeout: 10000,
    });
  } catch (err) {
    return { kind: 'error', hookId, message: String(err?.message || err) };
  }

  if (result.error) {
    return { kind: 'error', hookId, message: String(result.error.message || result.error) };
  }

  const response = parseLastJsonLine(result.stdout);
  if (!response) {
    return { kind: 'error', hookId, message: 'no parseable response' };
  }

  if (response.decision === 'block') {
    // The child just wrote its envelope to state.json. Capture it before the
    // next child overwrites, then clear so the final coalesced envelope is the
    // only blocked-hook record after the gate finishes.
    const fresh = readState(cwd) || {};
    const finding = {
      hookId: fresh.blocked_by_hook || hookId,
      code: fresh.block_code || 'unknown',
      reason: fresh.block_reason || response.reason || '',
      resume_instruction: fresh.resume_instruction || '',
      retry_context: fresh.retry_context || {},
    };
    clearBlockedHook(cwd, {
      hookId: finding.hookId,
      artifact: fresh.blocked_artifact || BLOCKED_ARTIFACT,
    });
    return { kind: 'block', finding };
  }

  if (response.systemMessage || response.hookSpecificOutput?.additionalContext) {
    const message = response.systemMessage
      || response.hookSpecificOutput?.additionalContext
      || '';
    return { kind: 'warn', hookId, message };
  }

  return { kind: 'ok', hookId };
}

function summarizeFailures(failures) {
  const lines = failures.map((f, i) => {
    const head = `  ${i + 1}. [${f.hookId}] (${f.code})`;
    const reason = (f.reason || '').trim().replace(/\s+/g, ' ');
    return reason ? `${head}\n     ${reason}` : head;
  });
  return [
    `[MPL Finalize Gate] ${failures.length} validation failure(s) detected on the finalize_done=true write. ` +
      `Resolve every item below in one batch, then retry the write:`,
    ...lines,
  ].join('\n');
}

function summarizeAdvisories(advisories) {
  if (!advisories.length) return '';
  const lines = advisories.map((a) => `  - [${a.hookId}] ${a.message.trim()}`);
  return ['[MPL Finalize Gate] Advisories (non-blocking):', ...lines].join('\n');
}

export async function runGate({ stdinPayload, cwd } = {}) {
  if (!stdinPayload) { ok(); return 'ok'; }

  let data;
  try {
    data = JSON.parse(stdinPayload);
  } catch {
    ok();
    return 'ok';
  }

  const toolName = data.tool_name || data.toolName || '';
  if (!/^(Edit|Write|MultiEdit)$/.test(toolName)) { ok(); return 'ok'; }

  const toolInput = data.tool_input || data.toolInput || {};
  if (!isFinalizeDoneWrite(toolInput)) { ok(); return 'ok'; }

  const resolvedCwd = cwd || data.cwd || data.directory || process.cwd();
  if (!isMplActive(resolvedCwd)) { ok(); return 'ok'; }

  const failures = [];
  const advisories = [];

  for (const hookFile of DELEGATES) {
    const outcome = delegateChild(hookFile, stdinPayload, resolvedCwd);
    if (outcome.kind === 'block') {
      failures.push(outcome.finding);
    } else if (outcome.kind === 'warn') {
      advisories.push({ hookId: outcome.hookId, message: outcome.message });
    }
    // 'error' and 'ok' contribute nothing — errors are logged via stderr by the
    // child itself; the gate fails open per the MPL "non-blocking on error"
    // convention so a broken delegate cannot pin the pipeline.
  }

  const state = readState(resolvedCwd) || {};

  if (failures.length === 0) {
    // No blockers. If advisories surfaced, attach them to the warn surface; the
    // gate still passes (consistent with each child's individual warn outcome).
    if (advisories.length === 0) {
      emitClearedOk(resolvedCwd, { hookId: HOOK_ID, artifact: BLOCKED_ARTIFACT });
      return 'ok';
    }
    clearBlockedHook(resolvedCwd, { hookId: HOOK_ID, artifact: BLOCKED_ARTIFACT });
    console.log(JSON.stringify({
      continue: true,
      systemMessage: summarizeAdvisories(advisories),
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: summarizeAdvisories(advisories),
      },
    }));
    return 'warn';
  }

  const reason = summarizeFailures(failures);
  emitBlockedHook(resolvedCwd, state, {
    hookId: HOOK_ID,
    ruleId: 'finalize_gate_failures',
    code: 'finalize_gate_failures',
    artifact: BLOCKED_ARTIFACT,
    reason,
    resumeInstruction:
      'Address every entry in retry_context.failures[]. Each entry preserves the originating validator\'s hookId, code, and reason. Once all are resolved, retry the finalize_done=true write — the gate re-runs every validator on the new write.',
    retryContext: {
      failures: failures.map((f) => ({
        hookId: f.hookId,
        code: f.code,
        reason: f.reason,
        resume_instruction: f.resume_instruction,
        retry_context: f.retry_context,
      })),
      advisories,
    },
  });
  return 'block';
}

async function main() {
  // Recursion guard: if a parent gate spawned us (shouldn't happen since the
  // four child hooks are delegated directly via spawnSync), bail.
  if (process.env[ENV_GUARD_KEY] === '1') {
    ok();
    return;
  }
  const raw = await readStdin();
  if (!raw.trim()) {
    ok();
    return;
  }
  try {
    await runGate({ stdinPayload: raw });
  } catch {
    // Fail open — never wedge the pipeline because the gate itself crashed.
    ok();
  }
}

if (isMain) {
  await main();
}

export { isFinalizeDoneWrite, summarizeFailures, summarizeAdvisories, DELEGATES, HOOK_ID, BLOCKED_ARTIFACT };
