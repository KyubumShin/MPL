/**
 * #239 — Prompt over-prescription cleanup.
 *
 * Scope of THIS PR: C1 + C4 (prompt-only edits).
 * Deferred to follow-up: C2 (reviewer_required hook), C3 (batch_test
 * phase-runner integration), C6 (Hard 1 evidence_required gate).
 *
 * These are content tests on the agent prompts — when the prompt is
 * the only spec for a behavior, the AC is satisfied by removing the
 * over-prescriptive language and adding the replacement rule.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

function readPrompt(relPath) {
  return readFileSync(join(REPO_ROOT, relPath), 'utf-8');
}

// ---------------------------------------------------------------------------
// C1 — test count floor → contract-derived rule
// ---------------------------------------------------------------------------

test('#239 C1: mpl-test-agent drops the per-domain "(min N)" test count floor', () => {
  const text = readPrompt('agents/mpl-test-agent.md');
  // The audit-flagged hard floors. The over-prescription was that
  // these (min N) numbers MUSTed even when the contract only had a
  // few callable surfaces.
  assert.ok(
    !/\(min 3\)/.test(text),
    'agents/mpl-test-agent.md should no longer say "(min 3)" for api',
  );
  assert.ok(
    !/\(min 4\)/.test(text),
    'agents/mpl-test-agent.md should no longer say "(min 4)" for ai',
  );
  assert.ok(
    !/\(min 5\)/.test(text),
    'agents/mpl-test-agent.md should no longer say "(min 5)" for algorithm/db',
  );
});

test('#239 C1: mpl-test-agent prescribes the contract-derived assertion floor', () => {
  const text = readPrompt('agents/mpl-test-agent.md');
  assert.ok(
    /contract.derived|contract-derived/i.test(text),
    'agents/mpl-test-agent.md should mention contract-derived test floor',
  );
  // The AC rule: one assertion per (params, returns) tuple.
  assert.ok(
    /params.*returns|\(params,\s*returns\)/i.test(text),
    'agents/mpl-test-agent.md should describe the per-(params, returns) rule',
  );
});

test('#239 C1: mandatory-domain failure mode no longer mandates a fixed count', () => {
  const text = readPrompt('agents/mpl-test-agent.md');
  // Old text: "ui, api, algorithm, db, ai domains MUST produce tests"
  // — the failure-mode bullet must now key off the contract, not a
  // hardcoded domain set.
  assert.ok(
    /interface_contract.*produces|produces.*entry MUST/i.test(text),
    'failure-mode bullet must key off interface_contract.produces, not a hardcoded domain set',
  );
});

// ---------------------------------------------------------------------------
// C4 — type_policy / error_spec become optional
// ---------------------------------------------------------------------------

test('#239 C4: mpl-decomposer no longer requires type_policy: { applies: false }', () => {
  const text = readPrompt('agents/mpl-decomposer.md');
  // The Empty case sections must explicitly say omission is allowed.
  // Allow whitespace (incl. newlines) between "may" / "OMIT" and the field.
  assert.ok(
    /may\s+OMIT\s+the\s+`type_policy`/is.test(text),
    'mpl-decomposer.md should permit omitting type_policy when N/A',
  );
  assert.ok(
    /may\s+OMIT\s+the\s+`error_spec`/is.test(text),
    'mpl-decomposer.md should permit omitting error_spec when N/A',
  );
});

test('#239 C4 codex r1 [contract-break]: Output_Schema no longer marks type_policy/error_spec as REQUIRED on every phase', () => {
  // Codex r1: the Empty case sections relaxed to omit, but the
  // Output_Schema YAML kept "REQUIRED on every phase" — an agent
  // following the new rule would produce output that the same
  // prompt's schema labels invalid. Internal contradiction.
  const text = readPrompt('agents/mpl-decomposer.md');
  // The exact "REQUIRED on every phase" line that previously gated
  // both fields must be gone.
  assert.ok(
    !/REQUIRED on every phase\.[^\n]*\n\s*(?:type_policy|error_spec)\s*:/i.test(text),
    'Output_Schema must not mark type_policy/error_spec as REQUIRED on every phase',
  );
  // Each field's Output_Schema header should signal optional.
  const typePolicyHeader = text.match(/type_policy:\s*[^\n]*(?:\n\s*#[^\n]*)*/);
  const errorSpecHeader = text.match(/error_spec:\s*[^\n]*(?:\n\s*#[^\n]*)*/);
  assert.ok(typePolicyHeader, 'type_policy header must exist in Output_Schema');
  assert.ok(errorSpecHeader, 'error_spec header must exist in Output_Schema');
  // The prose right above each field declaration must explicitly say
  // OPTIONAL + the back-compat rule.
  const typePolicySection = text.slice(0, text.indexOf('type_policy:') + 200);
  assert.ok(
    /optional|OPTIONAL|may omit|may OMIT/i.test(typePolicySection.slice(typePolicySection.lastIndexOf('#'))),
    'type_policy Output_Schema banner must call out OPTIONAL / may omit',
  );
});

test('#239 C4 codex r1 [contract-break]: orchestrator validate list does not demand type_policy/error_spec', () => {
  // commands/mpl-run-decompose.md (d) listed the fields the
  // orchestrator validates after the agent run. Keeping
  // type_policy/error_spec in that list would force the orchestrator
  // to fail the run even though the agent legitimately omitted them.
  const text = readPrompt('commands/mpl-run-decompose.md');
  const validateLine = text.match(/validate fields[^\n]*/i);
  assert.ok(validateLine, 'orchestrator validate-fields bullet must exist');
  // Either the line drops both field names, OR it explicitly notes
  // they're optional with the absence/legacy rule.
  const acceptable =
    !/\btype_policy\b/.test(validateLine[0]) ||
    /accept.*omitted.*type_policy|type_policy.*optional|absence\s*=\s*N\/A/i.test(validateLine[0]);
  assert.ok(
    acceptable,
    `validate-fields bullet must not unconditionally require type_policy: ${validateLine[0]}`,
  );
});

test('#239 C4: AP-DECOMP-05 reframed — absence is no longer a validation error', () => {
  const text = readPrompt('agents/mpl-decomposer.md');
  // The old AP-DECOMP-05 said: "Omission is a validation error".
  // The new wording must explicitly say absence is treated as N/A
  // AND keep backward-compat for the legacy `applies: false` form.
  const apBlock = text.match(/AP-DECOMP-05[^\n]+\n[^\n]*(?:\n[^\n]*){0,5}/);
  assert.ok(apBlock, 'AP-DECOMP-05 block must exist');
  assert.ok(
    /optional|OMIT|absence as|treat absence/i.test(apBlock[0]),
    'AP-DECOMP-05 must say type_policy/error_spec are optional / absence = N/A',
  );
  assert.ok(
    /back.?compat|backward.?compat|legacy/i.test(apBlock[0]),
    'AP-DECOMP-05 must note the legacy `applies: false` form stays accepted',
  );
});

test('#239 C4: no hook enforces type_policy/error_spec as required at runtime', () => {
  // The downstream tolerance promise. If a hook actively requires
  // type_policy on the phase YAML, omission would still hard-fail
  // and the prompt change would be a contract break.
  // (mpl-cache references the field name as the artifact filename
  // but does not require it on phases.)
  const requireFiles = [
    'hooks/mpl-require-goal-trace.mjs',
    'hooks/mpl-require-phase-contract-graph.mjs',
    'hooks/mpl-require-decomposition-delta.mjs',
    'hooks/mpl-require-phase-evidence.mjs',
    'hooks/mpl-validate-pp-schema.mjs',
    'hooks/mpl-artifact-schema.mjs',
  ];
  for (const f of requireFiles) {
    const text = readPrompt(f);
    // Allow string mentions only inside comments / artifact name maps —
    // never as a `missing.push('type_policy')` or `if (!phase.type_policy)`.
    const requiringPatterns = [
      /missing\.push\(['"`]type_policy['"`]\)/,
      /missing\.push\(['"`]error_spec['"`]\)/,
      /if\s*\(\s*!\s*\w+\.type_policy\s*\)/,
      /if\s*\(\s*!\s*\w+\.error_spec\s*\)/,
      /required.*type_policy/i,
      /required.*error_spec/i,
    ];
    for (const re of requiringPatterns) {
      assert.ok(
        !re.test(text),
        `${f} must not actively require type_policy/error_spec on phases (pattern: ${re.source})`,
      );
    }
  }
});
