/**
 * MPL Codex Auditor — thin re-export shim (Move #13).
 *
 * Move #13 relocated the F6 Tier 4 finalize-time audit into
 * `hooks/lib/policy/audit.mjs` (the new L2 policy SSOT). This file is a
 * re-export hub so existing test imports and any latent direct importers
 * keep working byte-equivalent to the pre-move surface.
 *
 * Mirrors the `hooks/lib/mpl-state.mjs` pattern — pure re-export, no
 * additional logic.
 *
 * Byte-identical pre-move implementation is preserved at
 * `hooks/lib/mpl-codex-audit.legacy.mjs` for diff comparison and
 * emergency rollback (per the convention shared with the 25+ other
 * `*.legacy.mjs` files in `hooks/`).
 */

import {
  // Pure parsers / surface implementations
  parseDecompositionPhases,
  enumerateIncludedUserCases,
  findMissingCovers,
  findScopeDrift,
  auditAntiPatternResidual,
  isLegacyContractMode,
  findManifestDrift,
  // Verdict utilities
  computeVerdict,
  resolveRequiredClean,
  resolveDriftEscalation,
  DEFAULT_REQUIRED_CLEAN,
  LEGACY_REQUIRED_CLEAN,
  // Top-level runner (default = new declarative verdict; pass
  // `opts.legacyVerdict: true` for emergency rollback semantics).
  runCodexAudit,
  // Decision-envelope sub-handlers and dispatcher
  handle,
  handleAudit,
  handleFinalizeAudit,
  AUDIT_HOOK_ID,
  AUDIT_REPORT_PATH,
} from './policy/audit.mjs';

export {
  parseDecompositionPhases,
  enumerateIncludedUserCases,
  findMissingCovers,
  findScopeDrift,
  auditAntiPatternResidual,
  isLegacyContractMode,
  findManifestDrift,
  computeVerdict,
  resolveRequiredClean,
  resolveDriftEscalation,
  DEFAULT_REQUIRED_CLEAN,
  LEGACY_REQUIRED_CLEAN,
  runCodexAudit,
  handle,
  handleAudit,
  handleFinalizeAudit,
  AUDIT_HOOK_ID,
  AUDIT_REPORT_PATH,
};
