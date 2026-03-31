# MPL Config Schema

All fields for `.mpl/config.json`. Single source of truth for configuration.

> **Version**: v0.11.1
> **Last updated**: 2026-03-31

---

## Core Settings

| Field | Type | Default | Description | Source |
|-------|------|---------|-------------|--------|
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

## Manifest & Field Classification (v0.8.5)

### `.mpl/manifest.json` Schema

Generated at Step 5.4.5 (Finalize), consumed at Step 0.0.5 (Triage).
Separate from `.mpl/cache/phase0/manifest.json` (Phase 0 cache-specific).

| Field | Type | Description |
|-------|------|-------------|
| `version` | string | Manifest schema version (e.g., `"0.9.0"`) |
| `generated_at` | string (ISO 8601) | When manifest was generated |
| `commit_hash` | string | Git HEAD at generation time |
| `pipeline_tier` | `"frugal"` \| `"standard"` \| `"frontier"` | Last run's pipeline tier |
| `field_classification` | string | Last run's field classification |
| `artifact_count` | number | Number of tracked artifacts |
| `artifacts` | ArtifactEntry[] | Artifact metadata list |

### ArtifactEntry

| Field | Type | Description |
|-------|------|-------------|
| `path` | string | File path relative to project root |
| `hash` | string | SHA-256 content hash |
| `timestamp` | string (ISO 8601) | File last modified time |
| `source` | `"mpl"` \| `"cep"` | Generator (mpl = MPL pipeline, cep = Context Extraction Pipeline) |
| `category` | string | `"phase0"` \| `"decomposition"` \| `"interview"` \| `"decisions"` \| `"runbook"` \| `"analysis"` \| `"verification"` |

### Field Classification (`state.json → field_classification`)

| Value | Condition | MPL Scope | Phase 0 (v0.8.5) | Phase 0 (v0.9.0 planned) |
|-------|-----------|-----------|-------------------|--------------------------|
| `field-1` | No source or no manifest | ✅ Greenfield | full | full |
| `field-2` | Source + tests (>30%), no .mpl/ | ✅ Well-Documented | full | full + Gate 0.8 baseline |
| `field-3` | Source + minimal tests, no .mpl/ | ⚠️ WARNING | full | full + WARNING |
| `field-4-fresh` | .mpl/ + freshness ≥ 0.8 | ✅ AI-Built | full | cache hit + Delta PP |
| `field-4-stale` | .mpl/ + freshness 0.4~0.8 | ✅ AI-Built | full | partial re-execution |
| `field-4-degraded` | .mpl/ + freshness < 0.4 | ⚠️ WARNING | full | full + WARNING |

**Note**: Memory files (`.mpl/memory/*`) are excluded from freshness calculation — append-only files would cause false staleness.

## E2E Testing (v0.8.3)

| Field | Type | Default | Description | Source |
|-------|------|---------|-------------|--------|
| `e2e_timeout` | number | `60000` | Timeout per E2E scenario in milliseconds | `mpl-run-finalize.md` Step 5.0 |

---

## Example Configuration

```json
{
  "max_fix_loops": 10,
  "max_total_tokens": 900000,
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
