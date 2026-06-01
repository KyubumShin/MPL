/**
 * P2b — phase_details.impact backfill.
 *
 * Asserts that:
 *  1. `parseDecompositionPostprocessText` extracts a structured
 *     `impact = { create, modify, affected_tests }` on every phase
 *     (Touch 1).
 *  2. The flat `impact_files` field is still present alongside the
 *     structured shape (additive — no removal).
 *  3. The structured shape feeds `scheduler.route_to_phase` resolver
 *     (3) when planted on `state.execution.phase_details` (Touches 2+3
 *     are documentation; this test exercises the consumer).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseDecompositionPostprocessText } from '../lib/mpl-decomposition-postprocess.mjs';
import { route_to_phase } from '../lib/policy/scheduler.mjs';

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

const FIXTURE = `
goal_contract_hash: deadbeef
phases:
  - id: phase-1
    name: Auth
    phase_domain: backend
    phase_lang: typescript
    impact:
      create:
        - path: src/auth/login.ts
        - path: src/auth/session.ts
      modify:
        - path: src/server.ts
      affected_tests:
        - path: test/auth.test.ts
  - id: phase-2
    name: UI
    phase_domain: frontend
    phase_lang: typescript
    impact:
      create:
        - path: src/ui/page.tsx
      modify: []
      affected_tests:
        - path: test/ui.test.ts
`;

describe('parseDecompositionPostprocessText — structured impact', () => {
  it('extracts impact.create / modify / affected_tests per phase', () => {
    const parsed = parseDecompositionPostprocessText(FIXTURE);
    const p1 = parsed.phases.find((p) => p.id === 'phase-1');
    assert.ok(p1, 'phase-1 must parse');
    assert.deepEqual(p1.impact.create.sort(), ['src/auth/login.ts', 'src/auth/session.ts']);
    assert.deepEqual(p1.impact.modify, ['src/server.ts']);
    assert.deepEqual(p1.impact.affected_tests, ['test/auth.test.ts']);

    const p2 = parsed.phases.find((p) => p.id === 'phase-2');
    assert.ok(p2, 'phase-2 must parse');
    assert.deepEqual(p2.impact.create, ['src/ui/page.tsx']);
    assert.deepEqual(p2.impact.modify, []);
    assert.deepEqual(p2.impact.affected_tests, ['test/ui.test.ts']);
  });

  it('keeps the flat impact_files union alongside the structured shape', () => {
    const parsed = parseDecompositionPostprocessText(FIXTURE);
    const p1 = parsed.phases.find((p) => p.id === 'phase-1');
    assert.ok(Array.isArray(p1.impact_files));
    // flat union must contain every structured path
    for (const path of [...p1.impact.create, ...p1.impact.modify, ...p1.impact.affected_tests]) {
      assert.ok(p1.impact_files.includes(path), `impact_files missing ${path}`);
    }
  });

  it('emits empty arrays (not undefined) when a key is missing in YAML', () => {
    const parsed = parseDecompositionPostprocessText(`
phases:
  - id: phase-noimpact
    name: NoImpact
`);
    const p = parsed.phases.find((x) => x.id === 'phase-noimpact');
    assert.ok(p, 'phase-noimpact must parse');
    assert.deepEqual(p.impact, { create: [], modify: [], affected_tests: [] });
  });
});

describe('route_to_phase resolver (3) consumes structured impact', () => {
  it('matches file_path against phase_details[].impact.create', () => {
    const ctx = route_to_phase({
      event: { cwd: '/elsewhere', toolInput: { file_path: 'src/auth/login.ts' } },
      state: {
        running: [{ phase_id: 'phase-1', worktree_root: null }],
        execution: {
          phase_details: [
            {
              id: 'phase-1',
              impact: {
                create: ['src/auth/login.ts'],
                modify: ['src/server.ts'],
                affected_tests: ['test/auth.test.ts'],
              },
            },
          ],
        },
      },
      env: {},
    });
    assert.equal(ctx?.phase_id, 'phase-1');
  });

  it('matches file_path against phase_details[].impact.modify', () => {
    const ctx = route_to_phase({
      event: { cwd: '/elsewhere', toolInput: { file_path: 'src/server.ts' } },
      state: {
        running: [{ phase_id: 'phase-1', worktree_root: null }],
        execution: {
          phase_details: [
            { id: 'phase-1', impact: { create: [], modify: ['src/server.ts'] } },
          ],
        },
      },
      env: {},
    });
    assert.equal(ctx?.phase_id, 'phase-1');
  });

  it('falls through to (4) legacy when phase_details[].impact is missing', () => {
    const ctx = route_to_phase({
      event: { cwd: '/elsewhere', toolInput: { file_path: 'src/missing.ts' } },
      state: {
        current_phase: 'phase-legacy',
        started_at: '2026-06-01',
        running: [{ phase_id: 'phase-1', worktree_root: null }],
        execution: {
          phase_details: [{ id: 'phase-1' }], // no impact key
        },
      },
      env: {},
    });
    assert.equal(ctx?.phase_id, 'phase-legacy');
    assert.equal(ctx?._legacy, true);
  });
});
