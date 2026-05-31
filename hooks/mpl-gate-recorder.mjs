#!/usr/bin/env node
/**
 * MPL Gate Recorder — delegating wrapper (Move #12).
 *
 * The gate recorder mixes pure-observation (Bash gate classification +
 * test-agent dispatch record + phase-runner completion sync) with decision
 * side-effects (anomaly install, block clear, e2e_results write). Because
 * the decision side-effects are load-bearing for the orchestrator's resume
 * path, Move #12 keeps the full implementation under
 * `mpl-gate-recorder.legacy.mjs` and re-runs it from this wrapper. The
 * new `lib/observability/signals.mjs::handleGateRecorder` exposes the
 * pure-decision surface (`recorder.bash` + `recorder.task`) that the v2
 * engine will consume once Move #13 wires policy-side state writes; until
 * then this wrapper preserves the legacy stdout + state-write contract
 * byte-for-byte.
 *
 * The reason for the legacy-bridge (vs. a from-scratch wrapper) is that
 * the recorder's anomaly-block-install / self-clear logic spans state
 * sequencing across multiple readState/writeState cycles. Re-implementing
 * those at the wrapper layer would risk regressions on PR #218 / PR #232
 * fixes that the integration tests in `mpl-gate-recorder.test.mjs` and
 * `mpl-issue-232-recorder-semantic-gaps.test.mjs` lock in.
 */

import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Boot the legacy entry-point unchanged.
await import(pathToFileURL(join(__dirname, 'mpl-gate-recorder.legacy.mjs')).href);

// Re-export the v2 pure-decision surface for engine + tests.
export { handleGateRecorder, classifyGateCommand } from './lib/observability/signals.mjs';
