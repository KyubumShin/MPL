# MPL Config Schema

All fields for `.mpl/config.json`. Single source of truth for configuration.

> **Version**: v0.8.0
> **Last updated**: 2026-03-25

---

## Core Settings

| Field | Type | Default | Description | Source |
|-------|------|---------|-------------|--------|
| `maturity_mode` | `"explore"` \| `"standard"` \| `"strict"` | `"standard"` | Verification strictness — controls per-phase sizing and gate thresholds | `mpl-run-phase0.md`, `design.md` |
| `max_fix_loops` | number | `10` | Maximum Fix Loop iterations before pipeline failure | `mpl-run-execute-gates.md` |
| `max_total_tokens` | number | `900000` | Total token upper limit (v0.6.7: raised from 500K for 1M context) | `hooks/lib/mpl-state.mjs` |
| `gate1_strategy` | `"auto"` \| `"docker"` \| `"native"` \| `"skip"` | `"auto"` | Gate 1 test execution strategy | `mpl-run-execute-gates.md` |
| `hitl_timeout_seconds` | number | `30` | HITL (Human-in-the-Loop) response wait time in seconds | `design.md` |
| `tool_mode` | `"standalone"` \| `"mcp"` | `"standalone"` | Tool mode — standalone uses native Claude Code tools, MCP uses QMD server | `docs/standalone.md` |

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
| `phase_seed.enabled` | boolean | `true` (Frontier) | Enable Phase Seed generation for deterministic TODO structure | `mpl-run-execute.md` |

## Coverage & Metrics (Gate 1.5)

| Field | Type | Default | Description | Source |
|-------|------|---------|-------------|--------|
| `coverage_thresholds.lines` | number | `60` | Line coverage minimum % (strict mode: 80) | `mpl-run-execute-gates.md` |
| `coverage_thresholds.branches` | number | `50` | Branch coverage minimum % (strict mode: 70) | `mpl-run-execute-gates.md` |

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

## Cluster Ralph (V-01, v0.8.0)

| Field | Type | Default | Description | Source |
|-------|------|---------|-------------|--------|
| `cluster_ralph.enabled` | boolean | `true` | Enable Cluster Ralph feature-scoped verify-fix loop | `mpl-run-execute.md` |
| `cluster_ralph.max_fix_attempts` | number | `2` | Max fix attempts per cluster E2E failure | `mpl-run-execute.md` |

---

## Example Configuration

```json
{
  "maturity_mode": "standard",
  "max_fix_loops": 10,
  "max_total_tokens": 900000,
  "context_cleanup_window": 3,
  "coverage_thresholds": {
    "lines": 60,
    "branches": 50
  },
  "auto_pr": {
    "enabled": false,
    "base_branch": "auto"
  },
  "cluster_ralph": {
    "enabled": true,
    "max_fix_attempts": 2
  }
}
```
