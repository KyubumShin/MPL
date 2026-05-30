/**
 * #232 — Recorder semantic gaps after PR #231.
 *
 * Two structurally-distinct surfaces remained from the strict / recorder
 * unification work:
 *
 *  (1) The recorder cut at the first control operator and classified
 *      only the leading simple command, BUT it still stored the OVERALL
 *      shell exit code from the composite. So:
 *        - `npm test || true`             → leading=npm test (hard2),
 *                                            shell exit = 0 from `true`
 *        - `npm test ; true`              → leading=npm test (hard2),
 *                                            shell exit = 0 from `true`
 *        - `npx playwright test | tee X`  → leading=npx playwright (hard3),
 *                                            shell exit = tee's (typically 0)
 *      Result: a failing gate command could record as a PASS row in
 *      `state.gate_results`. The fix rejects composite shapes at the
 *      recorder classifier so the recorder drops the event entirely.
 *
 *  (2) The recorder accepts execution-wrapper heads (`docker`, `bash -lc`,
 *      `kubectl exec`) because they are legitimate gate evidence; the
 *      strict allowlist deliberately rejects them. A recorder write of
 *      `docker compose run app npm test` therefore re-classified as `null`
 *      on the next I12 STATE_WRITE check, firing a family mismatch on
 *      legitimate recorder evidence. The fix tags every recorder entry
 *      with `source: 'recorder'` and I12 skips strict re-validation for
 *      those entries.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

import {
  classifyRecordedCommand,
  classifyGateCommand,
  compositeRejectReason,
} from '../lib/mpl-gate-classify.mjs';
import { CURRENT_SCHEMA_VERSION } from '../lib/mpl-state.mjs';

const __filename = fileURLToPath(import.meta.url);
const STATE_INVARIANT_HOOK = join(dirname(__filename), '..', 'mpl-state-invariant.mjs');

// ---------------------------------------------------------------------------
// (1) Exit-code masking — composite shapes rejected at the recorder
// ---------------------------------------------------------------------------

describe('#232 (1) compositeRejectReason detection — unit', () => {
  // The classifier itself preserves PR #220's leading-command family
  // assignment so legitimate consumers (manual gate-evidence writes
  // with a redirect, structured-write tests probing family) still
  // resolve. The recorder hook (mpl-gate-recorder.mjs) consumes
  // compositeRejectReason() to refuse the write when the shell exit
  // would be unreliable; that integration is exercised in the next
  // suite via the live recorder.
  it('flags `||` as or_or — `||` swallows the failure', () => {
    assert.equal(compositeRejectReason('npm test || true'), 'or_or');
  });

  it('flags `;` as semicolon — `;` runs both, shell exit = last', () => {
    assert.equal(compositeRejectReason('npm test ; true'), 'semicolon');
  });

  it('flags bare `|` as pipe — exit = rightmost', () => {
    assert.equal(compositeRejectReason('npx playwright test | tee output.log'), 'pipe');
  });

  it('flags bare `&` as background', () => {
    assert.equal(compositeRejectReason('npm test &'), 'background');
  });

  it('flags newline / CR as newline', () => {
    assert.equal(compositeRejectReason('npm test\ntrue'), 'newline');
    assert.equal(compositeRejectReason('npm test\rtrue'), 'newline');
  });

  it('keeps `&&` (short-circuits — leading failure propagates)', () => {
    assert.equal(compositeRejectReason('npm test && echo ok'), null);
  });

  it('keeps redirects (`>`, `>>`, `&>`) — they do not mask exit codes', () => {
    assert.equal(compositeRejectReason('npm test > log.txt'), null);
    assert.equal(compositeRejectReason('npm test >> log.txt'), null);
    assert.equal(compositeRejectReason('npm test &> log.txt'), null);
  });

  it('keeps trailing comment shapes — `#` is shell-discarded', () => {
    assert.equal(compositeRejectReason('npm test # smoke'), null);
  });

  it('ignores operators inside single / double quotes (pytest -k filters)', () => {
    assert.equal(compositeRejectReason("pytest -k 'login || logout'"), null);
    assert.equal(compositeRejectReason('pytest -k "login || logout"'), null);
  });

  // Hermes review on PR #265: shell wrappers (`bash -c`, `sh -c`,
  // `bash -lc`, ...) hide the payload from the outer quote-aware
  // scan. The wrapper itself evaluates the masking operator
  // internally, so the bypass surface must extend into the wrapped
  // payload.
  it('flags `bash -lc "npm test || true"` — masking inside shell wrapper payload', () => {
    assert.equal(compositeRejectReason('bash -lc "npm test || true"'), 'or_or');
  });
  it('flags `sh -c "npx playwright test | tee out.log"` — pipe inside wrapped payload', () => {
    assert.equal(compositeRejectReason('sh -c "npx playwright test | tee out.log"'), 'pipe');
  });
  it('flags `bash -c \'npm test ; true\'` — semicolon inside wrapped payload', () => {
    assert.equal(compositeRejectReason("bash -c 'npm test ; true'"), 'semicolon');
  });
  it('flags `/usr/local/bin/bash -lc "npm test || true"` — path-qualified shell head', () => {
    assert.equal(compositeRejectReason('/usr/local/bin/bash -lc "npm test || true"'), 'or_or');
  });
  it('keeps `bash -lc "npm test && echo done"` — `&&` in payload still safe', () => {
    assert.equal(compositeRejectReason('bash -lc "npm test && echo done"'), null);
  });
  it('keeps `bash -lc "npm test"` — no composite in payload', () => {
    assert.equal(compositeRejectReason('bash -lc "npm test"'), null);
  });

  // Hermes follow-up review on PR #265 (HEAD 4caf885): two more
  // wrapper bypasses surfaced. The flag-with-value `-o pipefail`
  // consumed the loop's `-c` skip; nested wrappers needed iterative
  // peeling instead of one-shot.
  it('flags `bash -o pipefail -c "npm test || true"` — option flag with value precedes -c', () => {
    assert.equal(compositeRejectReason('bash -o pipefail -c "npm test || true"'), 'or_or');
  });
  it("flags `bash -lc \"bash -c 'npm test || true'\"` — nested shell wrapper", () => {
    assert.equal(compositeRejectReason(`bash -lc "bash -c 'npm test || true'"`), 'or_or');
  });
  it('flags `+o errexit -c` style (off-option flag) too', () => {
    assert.equal(compositeRejectReason('bash +o errexit -c "npm test || true"'), 'or_or');
  });
  it('flags `--rcfile <path> -c` (rcfile flag takes value)', () => {
    assert.equal(compositeRejectReason('bash --rcfile /tmp/rc -c "npm test ; true"'), 'semicolon');
  });
  it('keeps `bash -o pipefail -c "npm test"` — no payload composite', () => {
    assert.equal(compositeRejectReason('bash -o pipefail -c "npm test"'), null);
  });
  it('bounded depth: pathological nesting eventually falls open, recorder records', () => {
    // Past the bound, the helper falls open. This is documented behavior:
    // the bound is a runaway-loop backstop, not a real bypass surface (any
    // realistic command is well under 5 levels of wrapping).
    let nested = 'npm test || true';
    for (let i = 0; i < 10; i++) nested = `bash -c "${nested.replace(/"/g, '\\"')}"`;
    // No assertion that this returns null — only that it doesn't throw or hang.
    assert.doesNotThrow(() => compositeRejectReason(nested));
  });

  it('classifier still resolves leading family on composite shapes — PR #220 contract preserved', () => {
    // The classifier is unchanged for these shapes (the recorder is
    // where rejection happens). Asserting here so a future refactor
    // that moves rejection back into the classifier flags the
    // regression against PR #220's intent.
    assert.equal(classifyRecordedCommand('npm test || echo playwright'), 'hard2_coverage');
    assert.equal(classifyRecordedCommand('npm test > playwright'), 'hard2_coverage');
    assert.equal(classifyRecordedCommand('docker compose run app npm test'), 'hard2_coverage');
  });
});

// ---------------------------------------------------------------------------
// (2) Strict / recorder allowlist divergence — round-trip via source marker
// ---------------------------------------------------------------------------

describe('#232 (2) I12 skips strict re-validation for recorder-sourced entries', () => {
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mpl-232-i12-'));
    mkdirSync(join(tmp, '.mpl'), { recursive: true });
    writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
      schema_version: CURRENT_SCHEMA_VERSION,
      current_phase: 'phase3-gate',
      gate_results: {},
    }));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function runStateInvariant(stateDelta) {
    // Drive checkI12 by issuing a Task tool input that triggers
    // STATE_WRITE on state.json. The simplest path is to invoke the
    // hook with a Write of state.json containing the delta.
    const fullState = {
      schema_version: CURRENT_SCHEMA_VERSION,
      current_phase: 'phase3-gate',
      ...stateDelta,
    };
    const input = {
      cwd: tmp,
      // deriveTrigger() requires hook_event_name to map tool_name to a
      // STATE_WRITE trigger; without it the hook resolves to STOP and
      // skips the I12 check entirely.
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: {
        file_path: '.mpl/state.json',
        content: JSON.stringify(fullState),
      },
    };
    return JSON.parse(execFileSync('node', [STATE_INVARIANT_HOOK], {
      input: JSON.stringify(input),
      encoding: 'utf-8',
    }));
  }

  it('a recorder-sourced wrapper entry (`docker compose run app npm test`) does NOT surface I12', () => {
    // Pre-#232, this would have classified as `null` under strict
    // (head `docker` not in STRICT_GATE_HEAD_ALLOWLIST) and fired
    // GATE_COMMAND_FAMILY_MISMATCH. The `source: 'recorder'` marker
    // now causes I12 to skip the strict re-check for this entry.
    //
    // Other invariants (I6 missing hard1/hard3 evidence on this
    // minimal fixture, I13 phase0 artifact requirement) may still
    // surface — they are unrelated to #232. The narrow assertion is
    // that the surfaced reason MUST NOT mention I12 / family mismatch.
    const r = runStateInvariant({
      gate_results: {
        hard2_coverage: {
          command: 'docker compose run app npm test',
          exit_code: 0,
          timestamp: '2026-05-30T00:00:00.000Z',
          source: 'recorder',
        },
      },
    });
    const surfaced = r.reason || r.systemMessage || '';
    assert.doesNotMatch(
      surfaced,
      /I12|gate_command_family_mismatch|GATE_COMMAND_FAMILY_MISMATCH/i,
      `recorder-sourced wrapper entry must not trip I12, got: ${surfaced}`,
    );
  });

  it('a manually-written wrapper entry (no source marker) still surfaces I12', () => {
    // The carve-out is narrowly scoped to entries that claim recorder
    // provenance. Manual writes that try to pass a wrapper without
    // the marker stay flagged by the I12 invariant — strict default
    // policy is `warn` (ENFORCEMENT_DEFAULTS.state_invariant_violation
    // = 'warn'), so the hook returns continue:true with a systemMessage
    // naming I12 / GATE_COMMAND_FAMILY_MISMATCH. The carve-out must
    // not suppress that surfacing.
    const r = runStateInvariant({
      gate_results: {
        hard2_coverage: {
          command: 'docker compose run app npm test',
          exit_code: 0,
          timestamp: '2026-05-30T00:00:00.000Z',
        },
      },
    });
    // Either decision === 'block' (strict mode) or warn with the
    // I12 / family-mismatch text — both prove the strict path remains
    // load-bearing for the hand-edit shape.
    const surfaced = r.decision === 'block' || typeof r.systemMessage === 'string';
    assert.ok(surfaced, `expected I12 to surface for manual write, got ${JSON.stringify(r)}`);
    const message = r.reason || r.systemMessage || '';
    assert.match(message, /I12|gate_command_family_mismatch|GATE_COMMAND_FAMILY_MISMATCH/i,
      `expected I12 message, got ${message}`);
  });

  it('a recorder-sourced slot-mismatch (npm test in hard3 slot) does NOT surface I12 (other invariants may still fire)', () => {
    // The source-marker carve-out trusts the classification the
    // recorder produced; it does NOT trust that an arbitrary command
    // was placed in the right family slot. Today the recorder writes
    // each command into the slot it classified into, so a slot/family
    // mismatch is a manual-edit / drift shape — out of #232's scope.
    //
    // The relevant assertion is therefore narrow: the I12
    // GATE_COMMAND_FAMILY_MISMATCH text MUST NOT appear in the
    // surfaced reason for a source:'recorder' entry. Other
    // invariants (I6 — missing structured gate evidence for the
    // other Hard slots) still fire on this minimal fixture and may
    // produce a block; that is intentional and unrelated to #232.
    const r = runStateInvariant({
      gate_results: {
        hard3_resilience: {
          command: 'npm test',
          exit_code: 0,
          timestamp: '2026-05-30T00:00:00.000Z',
          source: 'recorder',
        },
      },
    });
    const surfaced = r.reason || r.systemMessage || '';
    assert.doesNotMatch(
      surfaced,
      /I12|gate_command_family_mismatch|GATE_COMMAND_FAMILY_MISMATCH/i,
      `I12 must not surface for source:'recorder' entries, got: ${surfaced}`,
    );
  });

  it('strict allowlist is unaffected for manual writes — wrapper still rejected', () => {
    // Direct unit-level check that strict classification is unchanged.
    assert.equal(classifyGateCommand('docker compose run app npm test'), null);
    assert.equal(classifyGateCommand('bash -lc "npm test"'), null);
    assert.equal(classifyGateCommand('kubectl exec pod -- npm test'), null);
  });
});

// ---------------------------------------------------------------------------
// Combined surface — both fixes are needed together
// ---------------------------------------------------------------------------

describe('#232 (1) recorder integration — masking composites do not produce gate_results entries', () => {
  let tmp;
  const RECORDER_HOOK = join(dirname(__filename), '..', 'mpl-gate-recorder.mjs');

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mpl-232-recorder-'));
    mkdirSync(join(tmp, '.mpl'), { recursive: true });
    writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
      schema_version: CURRENT_SCHEMA_VERSION,
      current_phase: 'phase3-gate',
    }));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function postToolUse(command, { exit_code = 0, stdout = '' } = {}) {
    const input = {
      cwd: tmp,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      tool_response: {
        exit_code,
        stdout,
      },
    };
    execFileSync('node', [RECORDER_HOOK], {
      input: JSON.stringify(input),
      encoding: 'utf-8',
      timeout: 5000,
    });
    return JSON.parse(readFileSync(join(tmp, '.mpl', 'state.json'), 'utf-8'));
  }

  it('`npm test || true` with shell exit 0 does NOT produce a hard2_coverage entry', () => {
    // The classic paraphrase: `|| true` swallows the npm test failure,
    // so the shell exit is 0 even when npm test failed. Pre-#232 the
    // recorder happily wrote a passing hard2_coverage entry. Now it
    // refuses to record any masking-composite shape.
    const state = postToolUse('npm test || true', { exit_code: 0 });
    assert.equal(state.gate_results?.hard2_coverage, undefined,
      `recorder must drop `||` composites, got: ${JSON.stringify(state.gate_results)}`);
  });

  it('`npx playwright test | tee output.log` does NOT produce a hard3_resilience entry', () => {
    const state = postToolUse('npx playwright test | tee output.log', { exit_code: 0 });
    assert.equal(state.gate_results?.hard3_resilience, undefined,
      `recorder must drop pipes, got: ${JSON.stringify(state.gate_results)}`);
  });

  it('`npm test ; true` does NOT produce a hard2_coverage entry', () => {
    const state = postToolUse('npm test ; true', { exit_code: 0 });
    assert.equal(state.gate_results?.hard2_coverage, undefined);
  });

  it('`npm test && echo done` DOES produce a hard2_coverage entry (safe shape)', () => {
    // `&&` short-circuits → leading failure propagates to the shell
    // exit. Recording this shape is safe.
    const state = postToolUse('npm test && echo done', { exit_code: 0 });
    assert.equal(state.gate_results?.hard2_coverage?.command, 'npm test && echo done');
    assert.equal(state.gate_results?.hard2_coverage?.exit_code, 0);
  });

  it('`npm test > log.txt` DOES produce a hard2_coverage entry (redirect is safe)', () => {
    const state = postToolUse('npm test > log.txt', { exit_code: 0 });
    assert.equal(state.gate_results?.hard2_coverage?.command, 'npm test > log.txt');
  });

  it('recorder writes carry `source: \'recorder\'` for #232 (2) round-trip', () => {
    const state = postToolUse('docker compose run app npm test', { exit_code: 0 });
    assert.equal(state.gate_results?.hard2_coverage?.source, 'recorder',
      'recorder must tag every entry with source: \'recorder\' so I12 can skip strict re-validation');
  });

  // Hermes review on PR #265 found this bypass: the masking
  // operator is hidden inside the shell wrapper's quoted payload, so
  // the outer compositeRejectReason scan let it through. The
  // wrapper-payload re-scan now catches it.
  it('`bash -lc "npm test || true"` (shell-wrapper masking) does NOT produce a hard2_coverage entry', () => {
    const state = postToolUse('bash -lc "npm test || true"', { exit_code: 0 });
    assert.equal(state.gate_results?.hard2_coverage, undefined,
      `recorder must drop wrapper-hidden masking composites, got: ${JSON.stringify(state.gate_results)}`);
  });

  it('`sh -c "npx playwright test | tee out.log"` (wrapped pipe) does NOT produce a hard3_resilience entry', () => {
    const state = postToolUse('sh -c "npx playwright test | tee out.log"', { exit_code: 0 });
    assert.equal(state.gate_results?.hard3_resilience, undefined,
      `recorder must drop wrapper-hidden pipes, got: ${JSON.stringify(state.gate_results)}`);
  });

  it('`bash -lc "npm test"` (no payload composite) DOES still record', () => {
    const state = postToolUse('bash -lc "npm test"', { exit_code: 0 });
    assert.equal(state.gate_results?.hard2_coverage?.command, 'bash -lc "npm test"');
  });
});
