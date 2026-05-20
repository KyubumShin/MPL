import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pivotSkill = readFileSync(new URL('../../skills/mpl-pivot/SKILL.md', import.meta.url), 'utf-8');
const interviewer = readFileSync(new URL('../../agents/mpl-interviewer.md', import.meta.url), 'utf-8');

describe('#99 mpl-pivot / interviewer boundary', () => {
  it('keeps mpl-pivot as a thin wrapper around mpl-interviewer', () => {
    assert.match(pivotSkill, /entrypoint wrapper only/);
    assert.match(pivotSkill, /agents\/mpl-interviewer\.md/);
    assert.match(pivotSkill, /commands\/mpl-run-phase0\.md/);
    assert.match(pivotSkill, /must not duplicate any of those stages/);
  });

  it('keeps stale pre-v0.17 routing language out of mpl-pivot', () => {
    assert.doesNotMatch(pivotSkill, /interview_depth/);
    assert.doesNotMatch(pivotSkill, /Triage/);
    assert.doesNotMatch(pivotSkill, /PLAN\.md/);
  });

  it('keeps mpl-interviewer as the single owner of PP interview logic', () => {
    assert.match(interviewer, /single owner of PP interview logic/);
    assert.match(interviewer, /pivot skill is\s+only a wrapper/);
    assert.doesNotMatch(interviewer, /interview_depth/);
    assert.doesNotMatch(interviewer, /Final ambiguity_score/);
  });
});
