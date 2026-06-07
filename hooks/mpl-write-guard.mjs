#!/usr/bin/env node
/**
 * MPL Write Guard Hook (PreToolUse) — thin shim (post Move #6).
 *
 * The entire source-edit decision graph (Edit/Write/MultiEdit/NotebookEdit
 * AND Bash AND Task) now lives in `lib/policy/source-edit.mjs`. This file
 * is responsible only for:
 *
 *   1. Reading stdin via `lib/stdin.mjs`.
 *   2. JSON parsing + tool filter + isMplActive short-circuit.
 *   3. Building the `event` envelope and calling `sourceEdit.handle()`.
 *   4. Translating the returned `{decision, reason, signals, sideEffects}`
 *      into the hook envelope JSON the engine expects (continue / decision
 *      / hookSpecificOutput / additionalContext).
 *   5. Applying every `sideEffect` in order (recordBlockedHook /
 *      clearBlockedHook / lockDecomposerChild / recordDecomposerDispatch /
 *      recordFirstTranscript). All side effects are wrapped in best-effort
 *      try/catch so they never break the hook response.
 *   6. Re-exporting the legacy named symbols `isAllowedPath` / `isSourceFile`
 *      / `isDangerousBashCommand` / `isDogfoodMode` so existing tests
 *      (mpl-write-guard.test.mjs unit assertions) keep importing without
 *      code change.
 *
 * fail-open on any uncaught error in main() — same posture as before.
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { isMplActive, readState, writeState } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-state.mjs')).href
);
const { readStdin } = await import(
  pathToFileURL(join(__dirname, 'lib', 'stdin.mjs')).href
);
const { recordBlockedHook, clearBlockedHook } = await import(
  pathToFileURL(join(__dirname, 'lib', 'mpl-blocked-hook.mjs')).href
);
const sourceEdit = await import(
  pathToFileURL(join(__dirname, 'lib', 'policy', 'source-edit.mjs')).href
);

const {
  handle,
  isAllowedPath,
  isSourceFile,
  isDangerousBashCommand,
  isDogfoodMode,
} = sourceEdit;

function applySideEffect(eff) {
  if (!eff || typeof eff !== 'object') return;
  try {
    switch (eff.kind) {
      case 'recordBlockedHook': {
        const { cwd, ...opts } = eff.payload;
        recordBlockedHook(cwd, opts);
        break;
      }
      case 'clearBlockedHook': {
        const { cwd, ...opts } = eff.payload;
        clearBlockedHook(cwd, opts);
        break;
      }
      case 'lockDecomposerChild': {
        const { cwd, callerTranscriptPath } = eff.payload;
        const state = readState(cwd) || {};
        const flag = state.decomposer_dispatch;
        if (flag && typeof flag === 'object' && typeof flag.child_transcript_path !== 'string') {
          writeState(cwd, {
            decomposer_dispatch: {
              ...flag,
              child_transcript_path: callerTranscriptPath,
            },
          });
        }
        break;
      }
      case 'recordDecomposerDispatch': {
        const { cwd, parentTranscriptPath } = eff.payload;
        writeState(cwd, {
          decomposer_dispatch: {
            dispatched_at: new Date().toISOString(),
            parent_transcript_path: parentTranscriptPath || null,
            child_transcript_path: null,
          },
        });
        break;
      }
      case 'recordFirstTranscript': {
        const { cwd, transcriptPath } = eff.payload;
        if (!transcriptPath || typeof transcriptPath !== 'string') break;
        const state = readState(cwd) || {};
        if (typeof state.first_transcript_seen === 'string' && state.first_transcript_seen) break;
        writeState(cwd, { first_transcript_seen: transcriptPath });
        break;
      }
      default:
        // Unknown side effect — ignore (forward-compatible).
        break;
    }
  } catch {
    // Best-effort; the decision is authoritative.
  }
}

function emit(decision) {
  switch (decision.decision) {
    case 'block': {
      console.log(JSON.stringify({
        continue: false,
        decision: 'block',
        reason: decision.reason,
      }));
      break;
    }
    case 'warn': {
      const additionalContext = decision.signals && decision.signals.additionalContext
        ? decision.signals.additionalContext
        : decision.reason;
      console.log(JSON.stringify({
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext,
        },
      }));
      break;
    }
    case 'allow':
    default:
      console.log(JSON.stringify({ continue: true, suppressOutput: true }));
      break;
  }
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
  const isWriteTool = [
    'Edit', 'Write', 'MultiEdit', 'NotebookEdit',
    'edit', 'write', 'multiEdit', 'multiedit', 'notebookEdit', 'notebookedit',
  ].includes(toolName);
  const isBashTool = ['Bash', 'bash'].includes(toolName);
  const isTaskTool = ['Task', 'Agent', 'task', 'agent'].includes(toolName);
  if (!isWriteTool && !isBashTool && !isTaskTool) {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    return;
  }

  const cwd = data.cwd || data.directory || process.cwd();
  const toolInput = data.tool_input || data.toolInput || {};
  const callerTranscriptPath = typeof data.transcript_path === 'string'
    ? data.transcript_path
    : (typeof data.transcriptPath === 'string' ? data.transcriptPath : null);

  // Record first-transcript BEFORE reading state for the policy handlers
  // so the dispatcher-identity gate sees the post-record value. Matches the
  // original mpl-write-guard.mjs ordering.
  if (callerTranscriptPath) {
    applySideEffect({
      kind: 'recordFirstTranscript',
      payload: { cwd, transcriptPath: callerTranscriptPath },
    });
  }

  const state = readState(cwd) || {};
  const mplActive = isMplActive(cwd);

  const event = {
    event: 'PreToolUse',
    toolName,
    toolInput,
    cwd,
    state,
    data,
    isMplActive: mplActive,
    callerTranscriptPath,
  };

  const decision = await handle(event);

  // Apply side effects in order before emitting the response.
  for (const eff of decision.sideEffects || []) {
    applySideEffect(eff);
  }

  emit(decision);
}

main().catch(() => {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
});

export { isAllowedPath, isSourceFile, isDangerousBashCommand, isDogfoodMode };
