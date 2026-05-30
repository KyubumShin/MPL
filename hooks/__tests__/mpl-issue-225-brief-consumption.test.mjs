/**
 * #225 consumption-side — brief is the primary execution contract.
 *
 * The producer + block-mode cutover landed in PR #226 (commit 6b98f44).
 * This file covers the remaining acceptance criteria the producer cutover
 * deferred:
 *
 *   - mpl-test-agent documents the brief as primary; legacy decomposition
 *     fields are explicitly the transitional fallback.
 *   - Executor dispatch in commands/mpl-run-execute.md references the brief
 *     path in the dispatched prompt and no longer pre-stuffs the legacy
 *     phase_verification_plan / interface_contract / domain_test_requirements
 *     blocks ad hoc.
 *
 * These are prompt-text invariants — regressing them silently would let the
 * dispatch drift back to scattered-field assembly while the brief gate
 * keeps blocking phases that don't have a brief. Test against the live
 * files so the docs drift detector catches it on the next change.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(__filename), '..', '..');

function readDoc(rel) {
  return readFileSync(join(REPO_ROOT, rel), 'utf-8');
}

test('#225: mpl-test-agent.md declares the brief as the primary execution contract', () => {
  const text = readDoc('agents/mpl-test-agent.md');
  // The brief path MUST appear in Step 1 — the agent reads it FIRST.
  assert.match(text, /\.mpl\/mpl\/phases\/\{phase_id\}\/test-agent-brief\.yaml/);
  // Step 1 must explicitly mark the brief as primary, not optional.
  assert.match(text, /PRIMARY EXECUTION CONTRACT/);
  // The legacy decomposition-field path must be tagged as a fallback,
  // not as the default. Producer-block-mode means the brief is present.
  assert.match(text, /TRANSITIONAL FALLBACK/);
});

test('#225: mpl-test-agent.md lists every brief field the agent must consume', () => {
  const text = readDoc('agents/mpl-test-agent.md');
  // The Step 1 contract must enumerate the brief's load-bearing fields by
  // name so a drift in the schema produces a visible test failure here
  // before it ships.
  for (const field of [
    'target_implementation_files',
    'interface_contracts',
    'a_item_coverage',
    's_item_coverage',
    'required_test_commands',
    'forbidden_conditions',
    'probing_targets',
    'expected_evidence_shape',
  ]) {
    assert.match(
      text,
      new RegExp(`\\b${field}\\b`),
      `mpl-test-agent.md Step 1 must name ${field} so the agent reads it from the brief`,
    );
  }
});

test('#225: mpl-run-execute.md test-agent dispatch references the brief path', () => {
  const text = readDoc('commands/mpl-run-execute.md');
  // The dispatch prompt must include the brief path so the test-agent
  // reads it on entry. The path is a template (`{phase_id}` interpolated
  // by the orchestrator), so we look for the literal template.
  assert.match(text, /\.mpl\/mpl\/phases\/\{phase_id\}\/test-agent-brief\.yaml/);
});

test('#225: mpl-run-execute.md no longer pre-stuffs the legacy ad-hoc blocks in the dispatch prompt', () => {
  const text = readDoc('commands/mpl-run-execute.md');
  // Locate the test-agent dispatch block and assert the legacy
  // template placeholders are gone from that block. The brief now
  // carries the same data — duplicating it inline invites drift.
  const dispatchMatch = text.match(/Task\(subagent_type="mpl-test-agent"[\s\S]*?run_in_background=can_pipeline_verification\)/);
  assert.ok(dispatchMatch, 'mpl-test-agent dispatch block must be present');
  const dispatch = dispatchMatch[0];
  // Old ad-hoc blocks that the brief replaces:
  assert.doesNotMatch(dispatch, /\{phase_verification_plan\}/,
    'dispatch must not interpolate {phase_verification_plan} ad hoc — the brief carries A/S items');
  assert.doesNotMatch(dispatch, /\{phase_definition\.interface_contract\}/,
    'dispatch must not interpolate {phase_definition.interface_contract} — the brief carries interface_contracts');
  assert.doesNotMatch(dispatch, /\{domain_test_requirements\[domain\]\}/,
    'dispatch must not interpolate {domain_test_requirements[domain]} — the brief carries forbidden_conditions / probing_targets');
});

test('#225: dispatch retains the impact-file list inline (anchor for the test-agent)', () => {
  // The brief's `target_implementation_files` mirrors this, but the
  // executor still passes the impact-file list inline so the test-agent
  // can cross-check against the actual Phase Runner output.
  const text = readDoc('commands/mpl-run-execute.md');
  const dispatchMatch = text.match(/Task\(subagent_type="mpl-test-agent"[\s\S]*?run_in_background=can_pipeline_verification\)/);
  assert.ok(dispatchMatch);
  assert.match(
    dispatchMatch[0],
    /files created\/modified by the Phase Runner/,
    'dispatch must still pass the Phase Runner impact-file list inline',
  );
});

test('#225: docs/schemas/test-agent-brief.md notes the consumption side as shipped', () => {
  const text = readDoc('docs/schemas/test-agent-brief.md');
  // The schema doc previously listed mpl-test-agent + executor dispatch
  // under "Still-deferred follow-ups". After the #225 consumption-side
  // PR they must move to a "shipped" section so the next reader knows
  // they're done.
  // Match the heading shape (`## Still-deferred follow-ups`), not the
  // literal string — the new "Consumption side (shipped)" section may
  // still reference the old heading name in its body prose.
  assert.doesNotMatch(text, /^##\s+Still-deferred follow-ups\s*$/m,
    'schema doc must move both items out of the deferred section after #225 ships');
  assert.match(text, /^##\s+Consumption side.*shipped/m,
    'schema doc must record that both consumption-side items are now in tree');
});
