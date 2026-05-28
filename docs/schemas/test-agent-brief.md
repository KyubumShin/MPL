# `test-agent-brief.yaml` schema

**Path**: `.mpl/mpl/phases/{phase_id}/test-agent-brief.yaml` (one per
phase where `test_agent_required: true`).

**Purpose**: Separate the `mpl-test-agent` execution contract from the
decomposer's responsibility surface (#212). The decomposer keeps its
existing focus — phase graph, interface contracts, success criteria,
probing hints. The brief turns those hints into concrete, executable
runbook fields the test agent consumes directly, without re-inferring
intent from the full decomposition.

A future "brief generator" responsibility (new agent OR extension of
`mpl-seed-generator`) writes this file; the MVP shipped with #212
defines the schema, validates it on `mpl-test-agent` dispatch, and
documents the contract. The brief generator itself is a follow-up.

## Required shape

```yaml
phase_id: phase-1                 # MUST match the directory phase id
phase_domain: api                 # e.g. api / data / ui / cli
phase_name: "Create widget"       # human-readable

# files the implementation phase is expected to touch — empty for
# documentation-only phases, required non-empty for code-bearing
# phases (the validator infers code-bearing from interface_contracts
# being non-empty).
target_implementation_files:
  - src/api/widgets.ts

# interface contracts the brief is verifying. References the phase's
# interface_contract.produces[] symbols from decomposition.yaml.
interface_contracts:
  - symbol: createWidget
    path: src/api/widgets.ts

# A/S item coverage map — every acceptance / success item the phase
# committed to in decomposition.yaml.verification_plan must appear here
# with a concrete test target.
a_item_coverage:
  - id: A-1
    test_target: "POST /widgets returns 201 with valid body"
s_item_coverage:
  - id: S-1
    test_target: "POST /widgets returns 422 on missing field"

# real commands the test-agent must run (non-empty list of non-trivial
# command strings). placeholder/echo/no-op commands are rejected.
required_test_commands:
  - "npm test -- src/api/widgets.test.ts"

# contract assertions (optional; if present, each must be a concrete
# expression, not a placeholder).
contract_assertions:
  - "createWidget(body) returns Promise<Widget>"

# probing hints converted to concrete adversarial test targets
# (optional list; reuses decomposition.yaml.phase.probing_hints).
probing_targets:
  - "retry on transient 5xx returns Result.failure"

# forbidden patterns inside test files — the test-agent must not
# satisfy verification with these shapes.
forbidden_conditions:
  - "Mock / stub of createWidget itself"
  - "Placeholder assertions (expect(true).toBe(true))"

# the final JSON shape mpl-test-agent must produce
expected_evidence_shape:
  phase_id: phase-1
  verdict: PASS|FAIL|INVALID
  test_results: { total, passed, failed, skipped }
  commands_run: [{command, exit_code}]
  test_files_created: [path, ...]
  a_item_coverage: [{id, status}]
  s_item_coverage: [{id, status}]
  bugs_found: []
```

## Validator (`hooks/lib/mpl-test-agent-brief.mjs`)

Exports `validateBrief(text)` returning `{ valid, errors }`. Required
checks for a code-bearing phase:

- `phase_id` non-empty string
- `target_implementation_files` non-empty array of strings (skipped for
  documentation-only briefs where `interface_contracts` is empty)
- `a_item_coverage` and `s_item_coverage` are arrays where every item
  has an `id` and a non-trivial `test_target` (rejects empty,
  placeholder strings like "TODO", "n/a")
- `required_test_commands` non-empty array of strings, each at least 5
  characters and not in a placeholder denylist (`echo`, `true`,
  `false`, `:`, `# todo`)
- `contract_assertions` (if present) — no placeholder-only strings
  (`expect(true)`, `TODO`, `n/a`)

Returns the structured violation list so the hook can surface a
copy-ready resume hint.

## Hook gate (`hooks/mpl-require-test-agent-brief.mjs`)

PreToolUse on `Task|Agent`. When `tool_input.subagent_type` matches
`mpl-test-agent` and the prompt names a `phase_id`:

1. Read `.mpl/mpl/decomposition.yaml` to confirm the phase has
   `test_agent_required: true`. If `false`, no brief required — pass.
2. Read `.mpl/mpl/phases/{phase_id}/test-agent-brief.yaml`. Missing →
   surface diagnostic (per enforcement mode below).
3. Run the validator. Any violations → surface diagnostic with the
   structured list.
4. Otherwise pass.

### Enforcement mode (`.mpl/config/test-agent-brief-enforcement.json`)

Codex r2 on PR #224 [contract-break]: until the brief producer
(follow-up issue) lands, blocking every existing required
mpl-test-agent dispatch would break the only mandatory independent
verification path. The MVP defaults to `warn` mode.

```json
{ "mode": "warn" }
```

Recognized values:

- `"warn"` (default) — emit the diagnostic as a `systemMessage` so
  operators see the missing-brief gap, but allow the dispatch to
  proceed.
- `"block"` — emit `decision: block`. Flip to this once the producer
  ships (follow-up issue) so every required phase MUST have a brief.
- `"off"` — silent skip; use only for transitional debugging.

The config file is optional; absence means `warn`.

## Non-goal (deferred to follow-up)

The MVP shipped with #212 does NOT include:

- A `mpl-verification-brief-generator` agent (or `mpl-seed-generator`
  extension that writes the brief) — the brief is currently expected
  to land manually or via an out-of-band orchestrator step. The
  follow-up issue tracks adding the producer.
- Updates to `mpl-test-agent`'s system prompt to declare the brief as
  its primary execution contract.
- Executor dispatch path changes that pre-load the brief into the
  test-agent prompt instead of assembling scattered decomposition
  fields ad hoc.

The MVP closes the schema + validation + enforcement gap so the
generator and consumer can land independently.
