# Changelog

All notable changes to MPL after v0.18.6 are documented here.
Pre-v0.19.0 history lives in `docs/design.md` §9 Version History.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to a pre-1.0 `0.MINOR.PATCH` scheme (see README §Versioning).

## [Unreleased]

## [0.19.0] — 2026-06-01 — v2 Architecture Cutover

### Architecture
- **#1** Extracted read-only state utilities into `hooks/lib/state/reader.mjs`.
- **#2 + #3** Extracted state writer + made MCP `state_write` delegate via subprocess to a single writer.
- **#4 + #5** Config v2 SSOT + additive `mpl-engine.mjs` engine skeleton.
- **#6** Source-edit policy module — closes Law 2 Bash bypass (redirect/tee/sed-i/dd-of/cp-mv/git-apply); `mpl-write-guard` now blocks by default.
- **#7** Channel-registry policy enforces registered knowledge-transfer channels.
- **#8 (A+B)** Contracts + structural evidence modules; 11 of 13 require-* hooks delegate to policy.
- **#9** Gates policy + quality-gate retry-counter fix.
- **#10** Permit policy with fail-closed default for `mpl-auto-permit`.
- **#11** Schemas policy absorbs four validator hooks into one module.
- **#12** Observability signals + trackers consolidated (11 hooks).
- **#13** Audit policy + Tier 4 verdict drift gating (Codex Auditor consumed by gate).
- **#14** dispatch.mjs ROUTES table + engine rollback tiers; hooks.json swapped 39 entries → 6 (one per event).
- **#15** CLI relocation + introspection SSOT + orphan cleanup.
- **#16** Scheduler + isolation policies + ExecutionContext threading.
- **#17** State shards + wave-reducer + reconcile + verifier reconcile mode (schema v6 → v7).
- **#18** Documentation reconciliation, version bump, yaml-mini fix (this release).

### Added
- `docs/redesign-proposal.html` — v2 architecture rationale and per-move log.
- `docs/changelog.md` — Keep-a-Changelog canonical changelog (this file).
- `docs/archive/2026-03-30-hooks-review.md` — archived pre-v2 hook review.
- `package.json` `version` field (was previously absent).

### Changed
- `hooks/hooks.json`: 39 individual hook entries → 6 dispatcher entries (one per event).
- `.mpl/state.json` schema: v6 → v7 (migration chain `hooks/lib/migrations/` auto-applies on first read).
- README v2 architecture section + agent count corrected (9 → 11).
- design.md §4 catalog: adds `mpl-seed-generator`, `mpl-test-agent` (reinstated), `mpl-adversarial-reviewer`, `mpl-codex-auditor` rows.
- design.md §6.1 `.mpl/` tree refreshed against current writer surface.
- design.md §7 hook count: 38 → 46 modules, framed as dispatched through `mpl-engine.mjs`.

### Removed (from documentation; behavior already gone in code)
- Hat / Triage / PP-Proximity router section in README (removed in v0.17.0 / #55; docs lagged).
- Advisory Gate from README "3 Hard Gates" section (removed in v0.12.3; docs lagged).
- Stale lib/ file references in README tree: `mpl-scope-scan`, `mpl-cache`, `mpl-routing-patterns`.

### Fixed
- `hooks/lib/yaml-mini.mjs` regression on `mpl.config.yaml:210-213` flow-style sequence (see "yaml-mini fix" below).

### Migration
- Existing `.mpl/state.json` files auto-migrate v1→v7 via `hooks/lib/migrations/`.
- `.legacy.mjs` sibling files retained for one release as rollback tier (will be removed in v0.20.0).
