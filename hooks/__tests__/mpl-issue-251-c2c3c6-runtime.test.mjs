/**
 * #251 — Follow-up to #239 C2/C3/C6 runtime work.
 *
 * AC coverage:
 *   - C2: docs phase with `reviewer_required: false` + non-empty
 *     rationale → adversarial-reviewer not dispatched.
 *   - C3: refactor phase with `batch_test: true` → per-TODO test
 *     rule relaxed.
 *   - C6: phase with `evidence_required: [goal_trace]` → Hard 1
 *     skips tooling demand.
 *
 * Runtime tests cover the new hook + schema-field declarations +
 * prompt wiring that downstream consumers will read.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { findReviewerRationaleGaps } from '../mpl-require-reviewer.mjs';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const HOOKS_DIR = join(REPO_ROOT, 'hooks');

function readPrompt(relPath) {
  return readFileSync(join(REPO_ROOT, relPath), 'utf-8');
}

function freshWorkspace() {
  const cwd = mkdtempSync(join(tmpdir(), 'mpl-251-'));
  mkdirSync(join(cwd, '.mpl', 'mpl'), { recursive: true });
  writeFileSync(
    join(cwd, '.mpl', 'state.json'),
    JSON.stringify({ current_phase: 'phase-1' }),
  );
  return cwd;
}

function runReviewerHook(cwd, payload) {
  const json = JSON.stringify(payload);
  const out = execSync(
    `node "${join(HOOKS_DIR, 'mpl-require-reviewer.mjs')}"`,
    {
      input: json,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    },
  ).toString();
  return JSON.parse(out.trim());
}

// ---------------------------------------------------------------------------
// C2 — reviewer_required + reviewer_rationale unit tests
// ---------------------------------------------------------------------------

test('#251 C2 [unit]: findReviewerRationaleGaps reports phases with reviewer_required:false but empty rationale', () => {
  const yaml = `phases:
  - id: phase-1
    reviewer_required: false
    reviewer_rationale: "Pure docs phase, no code change"
  - id: phase-2
    reviewer_required: false
    reviewer_rationale: ""
  - id: phase-3
    reviewer_required: false
  - id: phase-4
    reviewer_required: true
  - id: phase-5
`;
  const { offenders } = findReviewerRationaleGaps(yaml);
  // phase-2 has empty rationale, phase-3 has no rationale.
  // phase-1 has valid rationale → no offense.
  // phase-4 / phase-5 have reviewer_required:true or absent → no offense.
  assert.deepEqual(offenders.sort(), ['phase-2', 'phase-3']);
});

test('#251 C2 [unit]: quoted rationale string is treated as content', () => {
  const yaml = `phases:
  - id: phase-1
    reviewer_required: false
    reviewer_rationale: 'Single-quoted reason'
  - id: phase-2
    reviewer_required: false
    reviewer_rationale: "Double-quoted reason"
`;
  const { offenders } = findReviewerRationaleGaps(yaml);
  assert.deepEqual(offenders, []);
});

// ---------------------------------------------------------------------------
// C2 — hook end-to-end behavior
// ---------------------------------------------------------------------------

test('#251 C2 e2e: hook blocks decomposition.yaml Write when reviewer_required:false has no rationale', () => {
  const cwd = freshWorkspace();
  try {
    const decompPath = join(cwd, '.mpl', 'mpl', 'decomposition.yaml');
    const yaml = `phases:
  - id: phase-1
    reviewer_required: false
`;
    writeFileSync(decompPath, yaml);
    const decision = runReviewerHook(cwd, {
      cwd,
      tool_name: 'Write',
      tool_input: { file_path: decompPath, content: yaml },
    });
    assert.equal(decision.continue, false);
    assert.equal(decision.decision, 'block');
    assert.match(decision.reason, /phase-1/);
    assert.match(decision.reason, /reviewer_rationale/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#251 C2 e2e: hook lets a valid rationale through', () => {
  const cwd = freshWorkspace();
  try {
    const decompPath = join(cwd, '.mpl', 'mpl', 'decomposition.yaml');
    const yaml = `phases:
  - id: phase-1
    reviewer_required: false
    reviewer_rationale: "Pure docs phase, no code surface"
`;
    writeFileSync(decompPath, yaml);
    const decision = runReviewerHook(cwd, {
      cwd,
      tool_name: 'Write',
      tool_input: { file_path: decompPath, content: yaml },
    });
    assert.equal(decision.continue, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#251 C2 claude r1 [logic]: whitespace-only rationale is treated as missing', () => {
  // Claude r1 advisory promoted to a [logic] regression: a phase
  // with `reviewer_rationale: "   "` (whitespace-only) had no real
  // author intent but slipped through the length-only check. Fix:
  // trim before length check in findReviewerRationaleGaps.
  const yaml = `phases:
  - id: phase-1
    reviewer_required: false
    reviewer_rationale: "   "
  - id: phase-2
    reviewer_required: false
    reviewer_rationale: "\\t\\n  "
  - id: phase-3
    reviewer_required: false
    reviewer_rationale: "Pure docs, no code change"
`;
  const { offenders } = findReviewerRationaleGaps(yaml);
  assert.ok(offenders.includes('phase-1'), 'spaces-only rationale must be flagged');
  // phase-3 has real content → not flagged.
  assert.ok(!offenders.includes('phase-3'), 'real content rationale must pass');
});

test('#251 C2 codex r2: executor skip path checks rationale presence (defense-in-depth)', () => {
  // Codex r2: the executor must not blindly trust the PostToolUse
  // hook's precondition — pre-existing decompositions, hook IO
  // failures, restored-from-disk states can all arrive at dispatch
  // time with reviewer_required:false AND empty rationale. The
  // executor MUST verify at runtime and either reject the skip or
  // force the reviewer dispatch.
  const text = readPrompt('commands/mpl-run-execute.md');
  // The skip block must include a rationale-blank check before
  // emitting the telemetry and skipping.
  // Anchor on the section heading and read forward until the trailing
  // ``` fence that closes the skip-path code block.
  const skipBlock = text.match(
    /Skip path[^\n]*#239 C2[\s\S]*?\n```\n/,
  );
  assert.ok(skipBlock, 'Skip path block must exist');
  // Must explicitly trim + zero-length check.
  assert.match(
    skipBlock[0],
    /rationale\.length\s*==\s*0|trim\(\)\.length\s*==\s*0|blank/i,
  );
  // Must explicitly fall through to reviewer dispatch when blank.
  assert.match(
    skipBlock[0],
    /Forcing reviewer dispatch|fall through to the default dispatch|reject.*skip/i,
  );
  // The codex r2 attribution must be in the comment so a future
  // revert can be traced.
  assert.match(skipBlock[0], /codex r2|defense-in-depth/i);
});

test('#251 C2 codex r3 [logic]: YAML block-scalar rationale (|, >) requires deeper non-blank body', () => {
  // Codex r3: `reviewer_rationale: |` followed by a sibling key (or
  // EOF, or whitespace-only body) made `extractScalar` return the
  // literal `|` marker. After trim that was non-empty, so the gate
  // passed even though the author intent was absent. Fix: detect
  // block-scalar opener and collect deeper-indented content; empty
  // body → empty rationale.
  const empties = [
    // EOF after opener
    `phases:
  - id: phase-1
    reviewer_required: false
    reviewer_rationale: |`,
    // Sibling at same indent → no body
    `phases:
  - id: phase-1
    reviewer_required: false
    reviewer_rationale: |
  - id: phase-2
    reviewer_required: true
`,
    // Whitespace-only deeper body
    `phases:
  - id: phase-1
    reviewer_required: false
    reviewer_rationale: |


`,
    // Folded > marker, empty
    `phases:
  - id: phase-1
    reviewer_required: false
    reviewer_rationale: >`,
    // With chomping indicators
    `phases:
  - id: phase-1
    reviewer_required: false
    reviewer_rationale: |-
  - id: phase-2`,
  ];
  for (const yaml of empties) {
    const { offenders } = findReviewerRationaleGaps(yaml);
    assert.ok(
      offenders.includes('phase-1'),
      `expected block-scalar empty rationale to be flagged:\n${yaml}`,
    );
  }

  // Sanity: real multi-line block-scalar body → not flagged.
  const populated = `phases:
  - id: phase-1
    reviewer_required: false
    reviewer_rationale: |
      Boundary unclear; operator must confirm.
      Multi-line rationale spans multiple lines.
  - id: phase-2
    reviewer_required: true
`;
  assert.deepEqual(findReviewerRationaleGaps(populated).offenders, []);

  // Sanity: folded > with content → not flagged.
  const populatedFolded = `phases:
  - id: phase-1
    reviewer_required: false
    reviewer_rationale: >
      folded rationale across
      multiple lines becomes one paragraph
`;
  assert.deepEqual(findReviewerRationaleGaps(populatedFolded).offenders, []);
});

test('#251 C6 codex r3 [logic]: Hard 1 reads evidence_required from decomposition.yaml, not phase_details', () => {
  // Codex r3: `evidence_required` lives on the decomposition per-phase
  // entry, NOT on `state.execution.phase_details` (which only carries
  // id/name/status/pp/retry/result). An earlier draft read it off
  // phase_details — that read always returned undefined, so
  // `phase_evidence = []`, `all_non_tooling = false`, and the skip
  // path was dead code on every real run.
  const text = readPrompt('commands/mpl-run-execute-gates.md');

  // Must read decomposition.yaml at gate time.
  assert.match(
    text,
    /readDecompositionYaml|decomposition\.yaml|decomposition\.phases/i,
    'Hard 1 skip must read decomposition.yaml directly',
  );

  // Must JOIN completed phase ids back to the decomposition.
  assert.match(
    text,
    /decomp_phase_by_id|join completed phase ids|join.*decomposition|completed_decomp_phases/i,
    'Hard 1 must join completed phase ids back to decomposition entries',
  );

  // Stale read off phase_details.evidence_required must be gone.
  assert.ok(
    !/state\.execution\.phase_details[\s\S]{0,60}?\.evidence_required/.test(text),
    'Hard 1 must not read evidence_required off state.execution.phase_details (codex r3)',
  );

  // The fix attribution must be in the comment so a future revert
  // can be traced.
  assert.match(text, /codex r3|dead code on every real run|source of truth/i);
});

test('#251 C6 codex r2 [logic]: Hard 1 aggregates across ALL completed phases', () => {
  // Codex r2: Hard 1 runs ONCE for the whole pipeline. The skip
  // logic must check that EVERY completed phase has non-tooling-only
  // evidence, not just the most recent / one-off phase. A mixed
  // run (docs phase + code phase) must NOT let the docs phase
  // suppress the tooling demand for the code phase.
  const text = readPrompt('commands/mpl-run-execute-gates.md');

  // Must use a per-completed-phase aggregation, not single-phase keying.
  assert.match(
    text,
    /completed_phases|\.every\(|every completed phase|every phase in scope/i,
    'Hard 1 skip must aggregate over completed phases, not a single phase',
  );
  // The skip path must surface which phase ids justified the skip
  // so an operator can audit.
  assert.match(
    text,
    /skip_justifying_phases|skip-justifying phases|which phase ids|phase ids that/i,
    'Hard 1 skip must record which phase ids justified the skip',
  );
  // Stale single-phase classifier (top-level read of `phase.evidence_required`
  // without aggregation) must be gone. The current shape reads it INSIDE
  // `.every()`, which is fine.
  const preAggregationShape = text.match(
    /^phase_evidence\s*=\s*phase\.evidence_required[^\n]*\n[^\n]*\nrequests_tooling\s*=/m,
  );
  assert.ok(
    !preAggregationShape,
    'single-phase phase_evidence assignment followed by direct requests_tooling must be gone (codex r2 [logic])',
  );
});

test('#251 C2 codex r1 [contract-break]: hook reads post-write disk state, not pre-write content', () => {
  // Codex r1: original hook was registered as PreToolUse but read
  // disk — the disk file is the PRE-write version, so a write that
  // would introduce a rationale-less skip slipped through. Fix:
  // register as PostToolUse (disk now reflects the post-write merged
  // result). Regression test simulates the real PostToolUse path —
  // disk has the post-write content, hook reads it, and blocks.
  const cwd = freshWorkspace();
  try {
    const decompPath = join(cwd, '.mpl', 'mpl', 'decomposition.yaml');
    // Pre-write state: VALID decomposition. Mirrors a baseline where
    // the prior write put a non-empty rationale.
    writeFileSync(
      decompPath,
      `phases:
  - id: phase-1
    reviewer_required: false
    reviewer_rationale: "Pure docs phase, no code change"
`,
    );
    // Now simulate the PostToolUse delivery — the write already
    // committed to disk, and the on-disk content NOW has the bad
    // shape (rationale removed). We materialize this by writing the
    // bad bytes to disk BEFORE invoking the hook — that's what
    // PostToolUse semantics actually deliver.
    const badYaml = `phases:
  - id: phase-1
    reviewer_required: false
`;
    writeFileSync(decompPath, badYaml);
    const decision = runReviewerHook(cwd, {
      cwd,
      tool_name: 'Edit',
      tool_input: {
        file_path: decompPath,
        old_string: 'reviewer_rationale: "Pure docs phase, no code change"',
        new_string: '',
      },
    });
    assert.equal(decision.continue, false);
    assert.equal(decision.decision, 'block');
    assert.match(decision.reason, /phase-1/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#251 C2 codex r1: hook is registered as PostToolUse in hooks.json', () => {
  // Lifecycle correctness: the hook semantics (re-read disk) match
  // its registration. A future revert that moves it back to
  // PreToolUse would silently regress the codex r1 finding.
  const text = readPrompt('hooks/hooks.json');
  // The hook must appear under PostToolUse, not PreToolUse.
  const postToolUseBlock = text.match(/"PostToolUse"\s*:\s*\[([\s\S]*?)\n\s*\]\s*,?\s*\n\s*"Stop"/);
  assert.ok(postToolUseBlock, 'PostToolUse block must exist in hooks.json');
  assert.match(postToolUseBlock[1], /mpl-require-reviewer\.mjs/);
  // And must NOT appear under PreToolUse.
  const preToolUseBlock = text.match(/"PreToolUse"\s*:\s*\[([\s\S]*?)\n\s*\]\s*,\s*\n\s*"PostToolUse"/);
  assert.ok(preToolUseBlock, 'PreToolUse block must exist in hooks.json');
  assert.ok(
    !/mpl-require-reviewer\.mjs/.test(preToolUseBlock[1]),
    'mpl-require-reviewer must NOT be registered under PreToolUse',
  );
});

test('#251 C2 e2e: hook is silent on non-decomposition writes', () => {
  const cwd = freshWorkspace();
  try {
    const decision = runReviewerHook(cwd, {
      cwd,
      tool_name: 'Write',
      tool_input: { file_path: join(cwd, 'README.md'), content: 'hi' },
    });
    assert.equal(decision.continue, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#251 C2 e2e: hook is silent outside MPL workspaces', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mpl-251-no-mpl-'));
  try {
    const decision = runReviewerHook(cwd, {
      cwd,
      tool_name: 'Write',
      tool_input: {
        file_path: join(cwd, '.mpl', 'mpl', 'decomposition.yaml'),
        content: 'phases:\n  - id: phase-1\n    reviewer_required: false\n',
      },
    });
    assert.equal(decision.continue, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('#251 C2 e2e: hook accepts camelCase payload shape', () => {
  // Sibling-hook convention from #238 codex r2.
  const cwd = freshWorkspace();
  try {
    const decompPath = join(cwd, '.mpl', 'mpl', 'decomposition.yaml');
    const yaml = `phases:
  - id: phase-1
    reviewer_required: false
`;
    writeFileSync(decompPath, yaml);
    const decision = runReviewerHook(cwd, {
      cwd,
      toolName: 'Write',
      toolInput: { file_path: decompPath, content: yaml },
    });
    assert.equal(decision.continue, false);
    assert.equal(decision.decision, 'block');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// C2 — schema declaration in decomposer prompt
// ---------------------------------------------------------------------------

test('#251 C2 schema: mpl-decomposer Output_Schema declares reviewer_required + reviewer_rationale', () => {
  const text = readPrompt('agents/mpl-decomposer.md');
  assert.match(text, /reviewer_required\s*:\s*boolean/);
  assert.match(text, /reviewer_rationale\s*:\s*string/);
  // Must mirror the test_agent_required idiom: default true, set false
  // only for specific phase types.
  assert.match(text, /Default[^\n]*true/i);
  assert.match(text, /REQUIRED when reviewer_required is false/i);
});

test('#251 C2 wire: executor dispatch (commands/mpl-run-execute.md) honors reviewer_required:false', () => {
  const text = readPrompt('commands/mpl-run-execute.md');
  assert.match(text, /reviewer_required\s*==\s*false|reviewer_required:\s*false/);
  assert.match(text, /reviewer-skipped/);
  assert.match(text, /recordQualitySignal/);
});

// ---------------------------------------------------------------------------
// C3 — batch_test schema + Phase Runner Rule 4 prompt wiring
// ---------------------------------------------------------------------------

test('#251 C3 schema: decomposer Output_Schema declares phase-level batch_test', () => {
  const text = readPrompt('agents/mpl-decomposer.md');
  const c3Block = text.match(/#239 C3[\s\S]{0,800}?batch_test\s*:\s*boolean/);
  assert.ok(c3Block, 'mpl-decomposer.md must declare batch_test boolean under #239 C3');
});

test('#251 C3 schema: Seed Generator propagates batch_test to phase_seed', () => {
  const text = readPrompt('agents/mpl-seed-generator.md');
  assert.match(text, /batch_test\s*:\s*boolean/);
  assert.match(text, /#239 C3|phase_domain\s*∈\s*\{refactor/i);
});

test('#251 C3 wire: Phase Runner Rule 4 relaxes per-TODO test when batch_test:true', () => {
  const text = readPrompt('commands/mpl-run-execute.md');
  const rule4 = text.match(/Incremental testing[\s\S]{0,800}?(?=\n\s*\d+\.|$)/);
  assert.ok(rule4, 'Rule 4 block must exist');
  assert.match(rule4[0], /batch_test:\s*true/);
  assert.match(rule4[0], /Exception.*#239 C3|#239 C3.*Exception|batched implement-then-verify/i);
});

// ---------------------------------------------------------------------------
// C6 — Hard 1 honors phase.evidence_required
// ---------------------------------------------------------------------------

test('#251 C6 wire: Hard 1 skips tooling demand when evidence_required excludes tooling', () => {
  const text = readPrompt('commands/mpl-run-execute-gates.md');
  // The gate logic must name the field and the skip path.
  assert.match(text, /phase\.evidence_required|evidence_required/);
  assert.match(text, /Hard 1 SKIPPED.*evidence_required|evidence_required.*Hard 1 SKIPPED|#239 C6/i);
  // The non-tooling allowlist must be present.
  assert.match(text, /NON_TOOLING_EVIDENCE|non.tooling allowlist/i);
});

test('#251 C6 codex r1 [contract-break]: Hard 1 classifier is a non-tooling allowlist (so `command` counts as tooling)', () => {
  // Codex r1: an early draft used a tooling allowlist
  // (lint/type_check/build/lsp_diagnostics/tooling). That gave a free
  // pass to phases with `evidence_required: [command]` — a machine-
  // backed Bash exit-code-0 token that IS tooling but wasn't in the
  // list. Fix: inverted to a non-tooling allowlist
  // (goal_trace / manual / external_audit / documentation). Anything
  // outside that closed list — including `command`, `test_agent`,
  // future-added tokens — counts as tooling and Hard 1 demands tools.
  const text = readPrompt('commands/mpl-run-execute-gates.md');

  // 1. The allowlist itself must be the non-tooling form, not the
  //    tooling form. Reject the stale shape that listed `lint` etc.
  assert.ok(
    !/TOOLING_EVIDENCE\s*=\s*\[\s*["']lint["']/i.test(text),
    'Hard 1 must NOT define a tooling allowlist (the codex r1 [contract-break] regression)',
  );
  assert.match(text, /NON_TOOLING_EVIDENCE\s*=\s*\[\s*["']goal_trace["']/i);

  // 2. The closed list must NOT contain `command` (command IS tooling).
  const allowlistMatch = text.match(
    /NON_TOOLING_EVIDENCE\s*=\s*\[([^\]]*)\]/i,
  );
  assert.ok(allowlistMatch, 'NON_TOOLING_EVIDENCE allowlist must exist');
  const allowlistBody = allowlistMatch[1];
  for (const toolingToken of ['command', 'test_agent', 'lint', 'type_check', 'build']) {
    assert.ok(
      !new RegExp(`["']${toolingToken}["']`).test(allowlistBody),
      `non-tooling allowlist must NOT contain "${toolingToken}" (it counts as tooling)`,
    );
  }

  // 3. The classifier must explicitly call out that anything outside
  //    the closed list counts as tooling.
  assert.match(
    text,
    /EVERYTHING ELSE counts as tooling|anything outside.*counts as tooling|\bcommand\b.*counts as tooling/i,
  );
});

test('#251 C6 wire: Hard 1 still fails when tooling is requested but no tools are present', () => {
  // Sanity: the previous defensive check must still fire for the
  // tooling-requested path.
  const text = readPrompt('commands/mpl-run-execute-gates.md');
  assert.match(
    text,
    /Hard 1 FAIL.*No lint, type check, or build tool/i,
    'tooling-requested path must still hard-fail when no tools detected',
  );
});

// ---------------------------------------------------------------------------
// Discoverability — hook table, PURPOSES map
// ---------------------------------------------------------------------------

test('#251: docs/design.md Hook System table includes mpl-require-reviewer', () => {
  const text = readPrompt('docs/design.md');
  assert.match(text, /`mpl-require-reviewer`/);
  assert.match(text, /41 registered hook commands/);
});

test('#251: PURPOSES map (hooks/lib/mpl-hook-trace.mjs) has entry for mpl-require-reviewer', () => {
  const text = readPrompt('hooks/lib/mpl-hook-trace.mjs');
  assert.match(text, /'mpl-require-reviewer':\s*'[^']+'/);
});
