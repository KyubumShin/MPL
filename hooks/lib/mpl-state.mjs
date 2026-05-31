#!/usr/bin/env node
/**
 * MPL State Management Utility — pure facade.
 *
 * Stage A Move #2 (v2): both read-side and write-side state utilities now
 * live in `./state/reader.mjs` and `./state/writer.mjs`. This file is a
 * thin re-export hub so all existing import sites in `hooks/` and `lib/`
 * (40 isMplActive / 30 readState / many writeState / 1 initState /
 * 1 cleanPipelineScope / 1 checkConvergence / 1 migrateLegacyExecutionState,
 * plus the CURRENT_SCHEMA_VERSION / MAX_AMBIGUITY_HISTORY /
 * LEGACY_EXECUTION_STATE_PATH constants and the UnsupportedSchemaVersionError
 * class) keep working without edits.
 *
 * Behavior is byte-identical to the pre-split file: same atomic temp+rename,
 * same H8 fail-closed throw on writeState, same I5 lockstep + revert-on-
 * violation, same RUNBOOK side-effect after rename, same ring-buffer caps
 * (ambiguity_history=10, phase_scheduler_history=50, worktree_pool_history=50).
 */

import { deepMerge } from './mpl-state-merge.mjs';
import {
  readState,
  isMplActive,
  detectStateDrift,
  checkConvergence,
  migrateLegacyExecutionState,
  CURRENT_SCHEMA_VERSION,
  MAX_AMBIGUITY_HISTORY,
  LEGACY_EXECUTION_STATE_PATH,
} from './state/reader.mjs';
import {
  writeState,
  initState,
  cleanPipelineScope,
  UnsupportedSchemaVersionError,
} from './state/writer.mjs';

export { deepMerge };
export {
  readState,
  isMplActive,
  detectStateDrift,
  checkConvergence,
  migrateLegacyExecutionState,
  CURRENT_SCHEMA_VERSION,
  MAX_AMBIGUITY_HISTORY,
  LEGACY_EXECUTION_STATE_PATH,
};
export {
  writeState,
  initState,
  cleanPipelineScope,
  UnsupportedSchemaVersionError,
};
