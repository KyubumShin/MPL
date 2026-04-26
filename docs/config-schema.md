# MPL Config Schema

All fields for `.mpl/config.json`. Single source of truth for configuration.

> **Version**: v0.16.0 (v0.17 cleanup pending — `session_cache` added; manifest/field_classification marked removed)
> **Last updated**: 2026-04-26

---

## Core Settings

| Field | Type | Default | Description | Source |
|-------|------|---------|-------------|--------|
| `max_fix_loops` | number | `10` | Maximum Fix Loop iterations before pipeline failure | `mpl-run-execute-gates.md` |
| `gate1_strategy` | `"auto"` \| `"docker"` \| `"native"` \| `"skip"` | `"auto"` | Gate 1 test execution strategy | `mpl-run-execute-gates.md` |
| `hitl_timeout_seconds` | number | `30` | HITL (Human-in-the-Loop) response wait time in seconds | `design.md` |
| `tool_mode` | `"standalone"` \| `"full"` \| `"partial"` | `"standalone"` | Tool mode — standalone uses native Claude Code tools; full/partial activate LSP tier when available | `docs/standalone.md` |

## Context & Memory

| Field | Type | Default | Description | Source |
|-------|------|---------|-------------|--------|
| `context_cleanup_window` | number | `3` | Sliding window size — number of recent phases to retain detailed data (v0.7.0) | `mpl-run-execute-parallel.md` |

## Convergence Detection

| Field | Type | Default | Description | Source |
|-------|------|---------|-------------|--------|
| `convergence.stagnation_window` | number | `3` | Number of fix attempts to evaluate for stagnation | `design.md` |
| `convergence.min_improvement` | number | `5` | Minimum pass_rate improvement (%) to count as progressing | `design.md` |
| `convergence.regression_threshold` | number | `10` | pass_rate drop (%) that triggers immediate circuit break | `design.md` |

## Phase Seed (D-01, v0.6.0)

| Field | Type | Default | Description | Source |
|-------|------|---------|-------------|--------|
| `phase_seed.enabled` | boolean | `true` (pp_core) | Enable Phase Seed generation for deterministic TODO structure | `mpl-run-execute.md` |

## Chain-Scoped Seed (#34, Stage 1)

| Field | Type | Default | Description | Source |
|-------|------|---------|-------------|--------|
| `chain_seed.enabled` | boolean | `false` | Enable chain-scoped Seed Generator (Stage 1 feature flag) | `commands/mpl-run-execute.md` |
| `chain_seed.max_chain_size` | number | `5` | Maximum phases per chain (enforced in chain-assignment derivation) | `docs/schemas/chain-assignment.md` |
| `chain_seed.discovery_regen_enabled` | boolean | `true` | Allow Seed Generator re-invocation on Discovery Agent architectural verdict. **⚠️ Stage 2 예정: `agents/mpl-discovery-agent.md` 파일 미구현. true 설정 시 실제 dispatch 불가.** | `agents/mpl-discovery-agent.md` |

## Context Monitor (#34, Stage 1)

Token-counter + tool_call tracking for baton-pass trigger.

| Field | Type | Default | Description | Source |
|-------|------|---------|-------------|--------|
| `context_monitor.enabled` | boolean | `true` | Enable PostToolUse token tracking on Task/Agent | `hooks/mpl-context-monitor.mjs` |
| `context_monitor.mode` | `"measure"` \| `"enforce"` | `"measure"` | Stage 1 = measure-only (no baton-pass trigger). Stage 2 = enforce | `hooks/mpl-context-monitor.mjs` |
| `context_monitor.context_window_tokens` | number | `1_000_000` | Context window size for %% calc (opus 4.6 1M default; lower for non-extended models) | `hooks/mpl-context-monitor.mjs` |
| `context_monitor.baton_threshold_pct` | number | `60` | Token %% threshold for `baton_pass_now` at phase boundary | `hooks/mpl-context-monitor.mjs` |
| `context_monitor.force_threshold_pct` | number | `80` | Token %% threshold for `forced_baton_pass` | `hooks/mpl-context-monitor.mjs` |
| `context_monitor.dispatch_warn` | number | `30` | Warn when Task/Agent dispatches within single chain exceed this (internal tool uses inside subagents not counted) | `hooks/mpl-context-monitor.mjs` |

## Test Wait Policy (#34, Stage 2)

Runner waits for Test Agent result vs terminates based on cache TTL.

| Field | Type | Default | Description | Source |
|-------|------|---------|-------------|--------|
| `test_wait.cache_mode` | `"default"` \| `"extended"` | `"default"` | Prompt cache TTL mode (default=5min, extended=1h) | `commands/mpl-run-execute.md` |
| `test_wait.threshold_default_sec` | number | `270` | Runner waits if test_duration < this (default cache, 4.5min safety margin) | `commands/mpl-run-execute.md` |
| `test_wait.threshold_extended_sec` | number | `3300` | Runner waits if test_duration < this (extended cache, 55min margin) | `commands/mpl-run-execute.md` |
| `test_wait.pipelining_enabled` | boolean | `false` | Allow Runner to proceed to next phase while Test Agent verifies prev (non_pp opt-in) | `commands/mpl-run-execute.md` |

## Discovery Pipeline (#34, Stage 2)

| Field | Type | Default | Description | Source |
|-------|------|---------|-------------|--------|
| `discovery.scanner_enabled` | boolean | `true` | Enable Hook mechanical filter (Stage 4.2) | `hooks/mpl-discovery-scanner.mjs` |
| `discovery.agent_enabled` | boolean | `false` | Enable Discovery Agent opus dispatch on filter hits (Stage 2 feature flag). **⚠️ Stage 2 미구현: `agents/mpl-discovery-agent.md` 파일 부재. `true` 설정 시 dangling reference — dispatch 실패.** | `agents/mpl-discovery-agent.md` |
| `discovery.false_positive_threshold_pct` | number | `30` | Alert if Discovery Agent false_positive rate exceeds this (Gate 2 metric). **⚠️ Stage 2 미구현.** | `agents/mpl-discovery-agent.md` |

## Test Agent Override (AD-0007, v0.15.1)

File: `.mpl/config/test-agent-override.json` (separate from `.mpl/config.json` to make the bypass highly visible).

Schema:
```json
{
  "phase-3": "trivial doc edit — no runtime surface",
  "phase-5": "manual QA completed 2026-04-20 by kbshin",
  "*": "project-wide bypass (anti-pattern, flagged by doctor audit)"
}
```

Semantics:
- Each key is either a phase id (`phase-N`) or the blanket key `"*"`.
- Each value is a **user-supplied reason string** — required. Empty reasons are rejected by `hooks/mpl-require-test-agent.mjs`.
- Presence of a matching key bypasses the AD-0007 block for that phase. The hook logs the reason but does not validate its content.
- `"*"` is accepted (user has final say) but flagged by `mpl-doctor audit [g]` as a blanket bypass — use only for short-lived experiments where test-agent overhead is prohibitive.

| Condition | Hook behaviour |
|---|---|
| `test_agent_required: true` in decomposition AND no dispatch record AND no override | **BLOCK** phase-runner completion advancement |
| `test_agent_required: false` with explicit rationale | Allow, no dispatch needed |
| `test_agent_required` missing (legacy decomposition) | Default to `true` — require dispatch |
| Override exists for phase-id | Allow regardless of dispatch |

## E2E Scenario Override (AD-0008, v0.15.2)

File: `.mpl/config/e2e-scenario-override.json` (separate from `.mpl/config.json` and from `test-agent-override.json` — visibly scoped per AD).

Two accepted entry shapes:

**Shape A (AD-0008 extended, Recommended)**:
```json
{
  "E2E-3": {
    "reason": "Playwright가 CI 환경에서만 실행 가능 — 로컬 dev skip",
    "test_command_hash": "sha1-of-test-command-at-override-time",
    "recorded_at": "2026-04-20T10:00:00Z",
    "source": "hitl_failure_resolution"
  }
}
```

**Shape B (Legacy, AD-0007 style)**:
```json
{
  "E2E-4": "reason: environment-only scenario"
}
```

Semantics:
- `hooks/mpl-require-e2e.mjs` + finalize Step 5.0 accept both shapes
- Shape A's `test_command_hash` is used to invalidate the override if the scenario's `test_command` changes (scenario drift → override no longer trustworthy, user re-prompted)
- Shape A's `recorded_at` powers doctor audit `[h]` stale warning (>30 days)
- `source: "hitl_failure_resolution"` written automatically by finalize Step 5.0 when user selects "Override 추가"; user-authored entries may omit or use `"manual"`
- `"*"` blanket key accepted but flagged by doctor audit

| Condition | Hook behaviour |
|---|---|
| E2E-N required AND no state.e2e_results[E2E-N] AND no override | **BLOCK** finalize_done=true write |
| E2E-N required AND results[E2E-N].exit_code != 0 AND no override | **BLOCK** finalize_done=true write |
| E2E-N has override with non-empty reason | Allow regardless of results |
| Override exists but test_command_hash mismatches current scenario | Treat as absent, re-prompt via HITL |

## Hat Model (PP-Proximity, v0.11.0)

| Field | Type | Default | Description | Source |
|-------|------|---------|-------------|--------|
| `hat.default_level` | `"light"` \| `"standard"` \| `"full"` | `"auto"` | Override Hat level (auto = PP-proximity scoring) | `mpl-run-phase0.md` |
| `hat.pp_weight` | number | `0.40` | Weight for PP impact in pp_proximity formula | `mpl-run-phase0.md` |
| `hat.scope_weight` | number | `0.25` | Weight for file scope in pp_proximity formula | `mpl-run-phase0.md` |
| `hat.contract_weight` | number | `0.20` | Weight for contract change in pp_proximity formula | `mpl-run-phase0.md` |
| `hat.risk_weight` | number | `0.15` | Weight for risk signal in pp_proximity formula | `mpl-run-phase0.md` |

## Browser QA (Gate 1.7, T-03)

| Field | Type | Default | Description | Source |
|-------|------|---------|-------------|--------|
| `dev_server_url` | string | auto-detect | Dev server URL for QA — auto-detects from package.json scripts | `mpl-run-execute-gates.md` |

## PR Creation (T-04)

| Field | Type | Default | Description | Source |
|-------|------|---------|-------------|--------|
| `auto_pr.enabled` | boolean | `false` | Auto-create PR after pipeline completion | `mpl-run-finalize.md` |
| `auto_pr.base_branch` | string | `"auto"` | Base branch for PR — "auto" detects from git | `mpl-run-finalize.md` |

## Context Rotation

| Field | Type | Default | Description | Source |
|-------|------|---------|-------------|--------|
| `context_rotation.backend` | `"kitty"` \| `"tmux"` \| `"osascript"` | auto-detect | Terminal backend for session rotation | `hooks/lib/mpl-rotator.mjs` |

## Manifest & Field Classification — REMOVED (v0.17)

Pre-v0.17 generated `.mpl/manifest.json` at finalize (5.4.5) for the Step 0.0.5
Artifact Freshness Check + Field Classification. v0.17 (#55) deleted Step 0.0.5
along with `field_classification` / `freshness_ratio` / `pp_proximity` state
fields, which orphaned the manifest write. The schema and classification table
were removed from this doc on the same audit pass.

For v0.17 ground-truth provenance use `.mpl/mpl/baseline.yaml` (#59) — it is
the immutable post-Phase-0 snapshot consumed by delta calculation and rollback.


## E2E Testing (v0.8.3)

| Field | Type | Default | Description | Source |
|-------|------|---------|-------------|--------|
| `e2e_timeout` | number | `60000` | Timeout per E2E scenario in milliseconds | `mpl-run-finalize.md` Step 5.0 |

## MCP Session Cache (P1-3b, #79)

Per-project override for the global `~/.mpl/cache/sessions.json` TTL. The cache backs `mpl_score_ambiguity`, `mpl_classify_feature_scope`, and `mpl_diagnose_e2e_failure` — extending the resumed-session prompt cache across MCP server restarts.

| Field | Type | Default | Description | Source |
|-------|------|---------|-------------|--------|
| `session_cache.ttl_minutes` | number (>0) | `30` | Per-project override of the session-cache freshness window. Precedence: explicit `ttl_ms` (test only) > project config > global cache config > 30. | `mcp-server/src/lib/session-cache.ts` |

---

## Example Configuration

```json
{
  "max_fix_loops": 10,
  "context_cleanup_window": 3,
  "hat": {
    "default_level": "auto",
    "pp_weight": 0.40,
    "scope_weight": 0.25,
    "contract_weight": 0.20,
    "risk_weight": 0.15
  },
  "auto_pr": {
    "enabled": false,
    "base_branch": "auto"
  }
}
```
