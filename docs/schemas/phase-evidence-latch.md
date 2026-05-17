# Phase Evidence Latch Schema

Files:

- `.mpl/mpl/phases/phase-N/verification.md`
- `.mpl/mpl/phases/phase-N/state-summary.md`
- `.mpl/state.json`

Each phase declares `evidence_required` in `.mpl/mpl/decomposition.yaml`.
Completion is latched only when `verification.md` proves each required token.

## Verification Format

```markdown
## Criterion
phase success criteria

## Evidence Type
command, test_agent, goal_trace

## Evidence Latch
- command: PASS command="npm test" exit_code=0
- test_agent: PASS state.test_agent_dispatched.phase-1.timestamp=...
- goal_trace: PASS AC-1 AX-1
```

Generic evidence tokens such as `security`, `e2e`, or `file_exists` must have a
token-specific row with `PASS`, `result=pass`, or `exit_code=0`.

## Runtime Enforcement

- `hooks/mpl-require-phase-evidence.mjs` blocks `verification.md` writes when:
  - `## Evidence Latch` is missing
  - any declared `evidence_required` token has no PASS latch
  - `command` evidence lacks `exit_code=0`
  - `test_agent` evidence lacks `state.test_agent_dispatched[phase_id]`
  - `goal_trace` evidence is not backed by decomposition goal trace
- The same hook blocks `state-summary.md` writes until a valid
  `verification.md` exists. This matters because `state-summary.md` is disk
  truth for completed phase count.
- The same hook blocks `.mpl/state.json` writes that newly mark a phase
  `completed` unless that phase already has a valid verification latch.
- `.mpl/config.json { "phase_evidence_latch_required": false }` is an explicit
  migration opt-out.
