/**
 * MPL Schemas Policy (L2 module — Move #11)
 *
 * SSOT for FOUR schema/shape-validation hooks:
 *   1. pivot_points_schema  (PreToolUse Write|Edit|MultiEdit on
 *                            .mpl/pivot-points.md) — UC leakage denylist, BLOCKS.
 *   2. agent_output_schema  (PostToolUse Task|Agent for VALIDATE_AGENTS) —
 *                            expected-section presence check, BLOCKS via
 *                            `continue: false`, telemetry side effects
 *                            (trackTokenUsage + logPhaseProfile).
 *   3. seed_schema          (PostToolUse Task|Agent|Write|Edit|MultiEdit on
 *                            seed paths) — advisory system-reminder on
 *                            missing fields, NEVER blocks.
 *   4. property_audit       (CLI-mode audit) — pure observation, returns
 *                            declaration/used/unused summary.
 *
 * Public API:
 *   handle(event, ctx) -> dispatcher
 *   handlePivotPointsSchema(ctx) -> { action:'allow'|'block', code, reason, … }
 *   handleAgentOutputSchema(ctx) -> { action:'allow'|'block'|'noop',
 *                                     code, reason, sideEffects: [...] }
 *   handleSeedSchema(ctx)        -> { action:'allow'|'advisory'|'noop',
 *                                     code, reason, sideEffects: [...] }
 *   handlePropertyAudit(ctx)     -> { action:'report', payload }
 *
 * Decision envelope shape (mirrors contracts.mjs):
 *   { action, code, reason, ruleId, artifact,
 *     resumeInstruction, retryContext, sideEffects? }
 *
 * Schema sources stay frozen-in-module for Phase A — UC_SCHEMA_PATTERNS,
 * EXPECTED_SECTIONS, the required-field list inside validateSeed, and
 * DEFAULT_CONFIG_TARGETS (re-exported from the L1 property-check lib).
 * Wiring config.schemas.rules is out of scope (the registry is empty in
 * mpl.config.yaml).
 *
 * Dependency boundary (per hooks/lib/policy/README.md):
 *   - L1 helpers only — mpl-state, mpl-quality-signals, mpl-property-check,
 *     tool-input, mpl-block-surface, mpl-profile, mpl-artifact-schema.
 *   - Does NOT import contracts.mjs, evidence.mjs, gates.mjs, permit.mjs,
 *     source-edit.mjs, channel-registry.mjs.
 */

import { existsSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';

// L1 helpers
import { isMplActive, readState, writeState } from '../mpl-state.mjs';
import {
  isFileWriteTool,
  collectFileWrites,
} from '../tool-input.mjs';
import {
  detectSeedAmbiguityNotesGap,
  recordQualitySignal,
} from '../mpl-quality-signals.mjs';
import { recordTelemetryError } from '../mpl-profile.mjs';
import {
  runBatch as runPropertyBatch,
  DEFAULT_CONFIG_TARGETS as PROPERTY_DEFAULT_CONFIG_TARGETS,
} from '../mpl-property-check.mjs';

// ============================================================================
// Shared constants
// ============================================================================

export const SCHEMAS_HOOK_IDS = Object.freeze({
  pivot_points_schema: 'mpl-validate-pp-schema',
  agent_output_schema: 'mpl-validate-output',
  seed_schema:         'mpl-validate-seed',
  property_audit:      'mpl-property-check',
});

export const PIVOT_POINTS_BLOCKED_ARTIFACT = '.mpl/pivot-points.md';

// ----------------------------------------------------------------------------
// (1) pivot-points UC leakage patterns — legacy verbatim
// ----------------------------------------------------------------------------

export const UC_SCHEMA_PATTERNS = Object.freeze([
  { re: /^user_cases\s*:/m, name: 'user_cases:' },
  { re: /^deferred_cases\s*:/m, name: 'deferred_cases:' },
  { re: /^cut_cases\s*:/m, name: 'cut_cases:' },
  { re: /^\s{2,}user_delta\s*:/m, name: 'user_delta:' },
  { re: /^\s{2,}covers_pp\s*:/m, name: 'covers_pp:' },
  { re: /\bUC-\d{2,}\b/, name: 'UC-NN identifier' },
]);

// ----------------------------------------------------------------------------
// (2) Agent output schema — validate_prompt agents + expected sections
// ----------------------------------------------------------------------------

export const VALIDATE_AGENTS = new Set([
  'mpl-phase-runner',
  'mpl-decomposer',
  'mpl-interviewer',
  'mpl-test-agent',
  'mpl-codebase-analyzer',
  'mpl-doctor',
  'mpl-git-master',
  'mpl-phase0-analyzer',
]);

export const EXPECTED_SECTIONS = Object.freeze({
  'mpl-phase-runner': [
    'status',
    'state_summary',
    'verification',
  ],
  'mpl-decomposer': [
    'architecture_anchor',
    'phases',
  ],
  'mpl-interviewer': [
    'PP-',
    'Priority Order',
    'Interview Metadata',
  ],
  'mpl-test-agent': [
    'phase_id',
    'test_files_created',
    'test_results',
    'a_item_coverage',
  ],
  'mpl-codebase-analyzer': [
    'project_type',
    'modules',
    'external_deps',
    'test_infrastructure',
  ],
  'mpl-doctor': [
    'Results',
    'Tool Availability Detail',
    'Recommendations',
    'Summary',
  ],
  'mpl-git-master': [
    'Commits Created',
  ],
  'mpl-phase0-analyzer': [
    'type-policy',
    'error-spec',
  ],
});

// ----------------------------------------------------------------------------
// (3) Seed schema paths
// ----------------------------------------------------------------------------

export const SEED_PATH_RE = /(?:^|\/)\.mpl\/(?:seeds\/[^/]+|mpl\/phases\/[^/]+\/phase-seed|mpl\/chains\/[^/]+\/chain-seed)\.ya?ml$/;

// ----------------------------------------------------------------------------
// (4) Property check default targets — re-export the L1 constant
// ----------------------------------------------------------------------------

export const DEFAULT_CONFIG_TARGETS = PROPERTY_DEFAULT_CONFIG_TARGETS;

// ============================================================================
// Decision envelope builders
// ============================================================================

function allow({ ruleId, artifact, sideEffects } = {}) {
  return {
    action: 'allow',
    code: null,
    reason: null,
    ruleId: ruleId || null,
    artifact: artifact || null,
    resumeInstruction: null,
    retryContext: null,
    sideEffects: sideEffects || [],
  };
}

function noop({ ruleId, sideEffects } = {}) {
  // Distinct from allow: indicates the hook produced no decision-relevant
  // output for this event (e.g. wrong tool, MPL not active). Wrappers map
  // both allow and noop to the same `continue:true, suppressOutput:true`
  // stdout shape, but downstream callers may distinguish.
  return {
    action: 'noop',
    code: null,
    reason: null,
    ruleId: ruleId || null,
    artifact: null,
    resumeInstruction: null,
    retryContext: null,
    sideEffects: sideEffects || [],
  };
}

function block({ ruleId, code, reason, artifact, resumeInstruction, retryContext, sideEffects } = {}) {
  return {
    action: 'block',
    code: code || 'blocked',
    reason: reason || 'Schema validation failed.',
    ruleId: ruleId || null,
    artifact: artifact || null,
    resumeInstruction: resumeInstruction || 'Resolve the recorded schema violation, then retry.',
    retryContext: retryContext || {},
    sideEffects: sideEffects || [],
  };
}

function advisory({ ruleId, code, reason, artifact, additionalContext, sideEffects } = {}) {
  return {
    action: 'advisory',
    code: code || 'advisory',
    reason: reason || 'Schema advisory.',
    ruleId: ruleId || null,
    artifact: artifact || null,
    resumeInstruction: null,
    retryContext: null,
    additionalContext: additionalContext || reason || '',
    sideEffects: sideEffects || [],
  };
}

function report(payload) {
  return {
    action: 'report',
    code: null,
    reason: null,
    ruleId: null,
    artifact: null,
    resumeInstruction: null,
    retryContext: null,
    sideEffects: [],
    payload,
  };
}

// ============================================================================
// (1) PIVOT-POINTS SCHEMA — handlePivotPointsSchema
// ============================================================================

export function targetsPivotPointsFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  return /(^|\/)\.mpl\/pivot-points\.md$/.test(filePath);
}

export function extractProposedContent(toolInput, toolName) {
  if (!toolInput) return '';
  if (!isFileWriteTool(toolName)) return '';
  return collectFileWrites(toolInput)
    .map((entry) => entry.text)
    .filter(Boolean)
    .join('\n');
}

export function detectUcLeakage(content) {
  if (!content || typeof content !== 'string') return [];
  return UC_SCHEMA_PATTERNS.filter((p) => p.re.test(content));
}

export function formatPivotPointsBlockReason(hits) {
  const names = hits.map((h) => h.name).join(', ');
  return [
    `Blocked: .mpl/pivot-points.md (immutable PP file) must not contain UC-scoped schema.`,
    `Detected markers: ${names}.`,
    `UCs belong in .mpl/requirements/user-contract.md (0.16 Tier A').`,
    `If you are trying to persist user feature discoveries, write them to the user-contract file instead.`,
  ].join(' ');
}

// Legacy alias preserved so wrapper test imports stay stable.
export const formatBlockReason = formatPivotPointsBlockReason;

/**
 * Handle PreToolUse on a file-write tool, looking for UC-schema leakage into
 * `.mpl/pivot-points.md`. The wrapper still owns the cwd / state lookup and
 * the emitBlockedHook / emitClearedOk routing — this handler returns a
 * uniform decision envelope.
 *
 * ctx: { toolName, toolInput, cwd, state?, mplActive }
 */
export function handlePivotPointsSchema(ctx = {}) {
  const { toolName, toolInput, mplActive } = ctx;

  if (!isFileWriteTool(toolName)) {
    return noop({ ruleId: 'pp_schema_irrelevant_tool' });
  }
  if (!toolInput || typeof toolInput !== 'object') {
    return noop({ ruleId: 'pp_schema_no_input' });
  }

  const entries = collectFileWrites(toolInput)
    .filter((entry) => targetsPivotPointsFile(entry.filePath));

  if (entries.length === 0) {
    return noop({ ruleId: 'pp_schema_irrelevant_path' });
  }

  const content = entries.map((entry) => entry.text).filter(Boolean).join('\n');
  if (!content) {
    return noop({ ruleId: 'pp_schema_empty_content' });
  }

  const hits = detectUcLeakage(content);

  if (hits.length === 0) {
    // Clear path — wrappers translate this into emitClearedOk (when MPL
    // active) or a plain `continue:true` ok (pre-MPL workspace).
    return allow({
      ruleId: 'pp_schema_ok',
      artifact: PIVOT_POINTS_BLOCKED_ARTIFACT,
    });
  }

  const reason = formatPivotPointsBlockReason(hits);
  return block({
    ruleId: 'pp_schema_invalid',
    code: 'pp_schema_uc_leakage',
    artifact: PIVOT_POINTS_BLOCKED_ARTIFACT,
    reason,
    resumeInstruction:
      'Move every UC-scoped schema key out of .mpl/pivot-points.md into .mpl/requirements/user-contract.md, then retry the write.',
    retryContext: {
      markers: hits.map((h) => h.name),
      mplActive: !!mplActive,
    },
  });
}

// ============================================================================
// (2) AGENT OUTPUT SCHEMA — handleAgentOutputSchema
// ============================================================================

/**
 * Validate response text against expected sections (case-insensitive).
 */
export function validateSections(sections, responseText) {
  const missing = [];
  const found = [];
  const lower = String(responseText || '').toLowerCase();
  for (const section of sections) {
    if (lower.includes(section.toLowerCase())) {
      found.push(section);
    } else {
      missing.push(section);
    }
  }
  const sectionList = sections.map((s) => {
    const ok = found.includes(s);
    return `  - ${ok ? '[PASS]' : '[MISSING]'} ${s}`;
  }).join('\n');
  return { passed: missing.length === 0, missing, found, sectionList };
}

export function formatValidationMessage(agentType, sections, passed, missing, sectionList) {
  if (passed) {
    return `[MPL VALIDATION PASSED] Agent "${agentType}" output contains all ${sections.length} required sections.`;
  }
  return `[VALIDATION FAILED] [MPL VALIDATION FAILED] Agent "${agentType}" output is missing ${missing.length}/${sections.length} required sections.

Validation results:
${sectionList}

Missing sections: ${missing.join(', ')}

ACTION REQUIRED: Re-run the agent with clarified instructions targeting the missing sections.
Do NOT proceed to the next phase until all sections are present.`;
}

/**
 * Telemetry side-effect: track token usage. Best-effort; never blocks.
 * Records via writeState + appends to weekly + phases.jsonl.
 *
 * Surfaced as a `side effect` action descriptor on the decision envelope
 * so the wrapper can perform the I/O. Returns the descriptor list.
 */
export function trackTokenUsage(cwd, agentType, responseText) {
  const sideEffects = [];
  try {
    const estimatedTokens = Math.ceil(String(responseText || '').length / 4);
    if (estimatedTokens <= 0) return sideEffects;

    const currentState = readState(cwd);
    if (!currentState) return sideEffects;

    const currentTokens = currentState.cost?.total_tokens || 0;
    writeState(cwd, { cost: { total_tokens: currentTokens + estimatedTokens } });
    sideEffects.push({
      kind: 'state_write',
      key: 'cost.total_tokens',
      value: currentTokens + estimatedTokens,
    });

    // Weekly usage log
    try {
      const usageDir = join(cwd, '.mpl/usage');
      if (!existsSync(usageDir)) mkdirSync(usageDir, { recursive: true });
      const line = JSON.stringify({
        timestamp: new Date().toISOString(),
        tokens: estimatedTokens,
      }) + '\n';
      appendFileSync(join(usageDir, 'weekly.jsonl'), line);
      sideEffects.push({ kind: 'weekly_usage_append', tokens: estimatedTokens });
    } catch (err) {
      recordTelemetryError(cwd, 'mpl-validate-output:weeklyUsage', err, {
        agent_type: agentType || null,
      });
    }

    // Phase profile log
    try {
      const profileDir = join(cwd, '.mpl/mpl/profile');
      if (!existsSync(profileDir)) mkdirSync(profileDir, { recursive: true });
      const phaseRecord = {
        step: currentState.current_phase || 'unknown',
        name: agentType || '',
        pass_rate: null,
        micro_fixes: 0,
        estimated_tokens: {
          context: 0,
          output: estimatedTokens,
          total: estimatedTokens,
        },
        compaction_count: currentState.compaction_count || 0,
        timestamp: new Date().toISOString(),
      };
      appendFileSync(
        join(profileDir, 'phases.jsonl'),
        JSON.stringify(phaseRecord) + '\n',
      );
      sideEffects.push({ kind: 'phase_profile_append', agent: agentType || '' });
    } catch (err) {
      recordTelemetryError(cwd, 'mpl-validate-output:logPhaseProfile', err, {
        agent_type: agentType || null,
        phase: currentState?.current_phase || null,
      });
    }
  } catch (err) {
    recordTelemetryError(cwd, 'mpl-validate-output:trackTokenUsage', err, {
      agent_type: agentType || null,
    });
  }
  return sideEffects;
}

/**
 * Handle PostToolUse Task/Agent completion. Runs token telemetry for ALL
 * Task completions (when MPL active), then validates expected sections for
 * the VALIDATE_AGENTS subset.
 *
 * ctx: { toolName, toolInput, toolResponse, cwd, mplActive }
 */
export function handleAgentOutputSchema(ctx = {}) {
  const { toolName, toolInput, toolResponse, cwd, mplActive } = ctx;

  // Only intercept Task/Agent
  if (!['Task', 'task', 'Agent', 'agent'].includes(toolName)) {
    return noop({ ruleId: 'agent_output_irrelevant_tool' });
  }
  if (!mplActive) {
    return noop({ ruleId: 'agent_output_mpl_inactive' });
  }

  const agentType =
    (toolInput && (toolInput.subagent_type || toolInput.subagentType)) || '';
  const responseText = typeof toolResponse === 'string'
    ? toolResponse
    : (toolResponse ? JSON.stringify(toolResponse) : '');

  // Telemetry runs for ALL Task completions (not just validated agents).
  const sideEffects = trackTokenUsage(cwd, agentType, responseText);

  if (!VALIDATE_AGENTS.has(agentType)) {
    return allow({
      ruleId: 'agent_output_not_validated_agent',
      sideEffects,
    });
  }

  const sections = EXPECTED_SECTIONS[agentType] || [];
  const { passed, missing, found, sectionList } =
    validateSections(sections, responseText);
  const message = formatValidationMessage(
    agentType, sections, passed, missing, sectionList,
  );

  if (passed) {
    return allow({
      ruleId: 'agent_output_sections_ok',
      sideEffects,
      // Wrapper still surfaces the [MPL VALIDATION PASSED] line via
      // additionalContext per the legacy stdout shape.
      // Attach as extra metadata; envelope shape stays uniform.
      // (Wrapper reads .additionalContext below — non-canonical field,
      // similar to gates.mjs advisory extension.)
    });
  }

  return block({
    ruleId: 'agent_output_sections_missing',
    code: 'agent_output_validation_failed',
    artifact: `.mpl/agents/${agentType}.output`,
    reason: message,
    resumeInstruction:
      'Re-run the agent and ensure every required Output_Schema section is present.',
    retryContext: { agentType, missing, found },
    sideEffects,
  });
}

// ============================================================================
// (3) SEED SCHEMA — handleSeedSchema
// ============================================================================

// ----------------------------------------------------------------------------
// YAML helpers (regex-based — legacy verbatim)
// ----------------------------------------------------------------------------

export function extractYaml(text) {
  if (!text || typeof text !== 'string') return null;
  const match = text.match(/```ya?ml\s*\n([\s\S]*?)```/);
  return match ? match[1] : null;
}

function escapeRegex(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function hasYamlField(yaml, keyPath) {
  if (!yaml) return false;
  const parts = String(keyPath || '').split('.');
  const leaf = parts[parts.length - 1];
  const keyRegex = new RegExp(`^[ \\t]*${escapeRegex(leaf)}\\s*:`, 'm');
  return keyRegex.test(yaml);
}

export function hasNonEmptyArray(yaml, key) {
  if (!yaml) return false;
  const regex = new RegExp(
    `^([ \\t]*)${escapeRegex(key)}\\s*:\\s*\\n((?:\\1[ \\t]+.*\\n?)*)`,
    'm',
  );
  const match = yaml.match(regex);
  if (!match) return false;
  const block = match[2];
  return /^\s+-\s+/m.test(block) || /^\s+-\s*$/m.test(block);
}

export function hasNonEmptyString(yaml, key) {
  if (!yaml) return false;
  const regex = new RegExp(
    `^[ \\t]*${escapeRegex(key)}\\s*:\\s*(.+)$`,
    'm',
  );
  const match = yaml.match(regex);
  if (!match) return false;
  const value = match[1].trim();
  if (!value || value === 'null' || value === '~' || value === '""' || value === "''") {
    return false;
  }
  return true;
}

export function extractMappingKeys(yaml, parentKey) {
  if (!yaml) return [];
  const regex = new RegExp(
    `^([ \\t]*)${escapeRegex(parentKey)}\\s*:\\s*\\n((?:\\1[ \\t]+.*\\n?)*)`,
    'm',
  );
  const match = yaml.match(regex);
  if (!match) return [];
  const block = match[2];
  const keys = [];
  const keyRegex = /^[ \t]+(\w[\w_-]*)\s*:\s*(.+)$/gm;
  let m;
  while ((m = keyRegex.exec(block)) !== null) {
    keys.push(m[1]);
  }
  return keys;
}

export function validateMappingValues(yaml, parentKey) {
  if (!yaml) return { valid: true, invalidKeys: [] };
  const regex = new RegExp(
    `^([ \\t]*)${escapeRegex(parentKey)}\\s*:\\s*\\n((?:\\1[ \\t]+.*\\n?)*)`,
    'm',
  );
  const match = yaml.match(regex);
  if (!match) return { valid: true, invalidKeys: [] };
  const block = match[2];
  const invalidKeys = [];
  const keyRegex = /^[ \t]+(\w[\w_-]*)\s*:\s*(.*)$/gm;
  let m;
  while ((m = keyRegex.exec(block)) !== null) {
    const value = m[2].trim();
    if (!value || value === 'null' || value === '~') {
      invalidKeys.push(m[1]);
    }
  }
  return { valid: invalidKeys.length === 0, invalidKeys };
}

function countIndent(line) {
  return (line.match(/^[ \t]*/) || [''])[0].length;
}

function extractTodoStructureBlocks(yaml) {
  const blocks = [];
  const lines = String(yaml || '').split('\n').map((line) => line.replace(/\r$/, ''));

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^([ \t]*)todo_structure\s*:\s*(.*)$/);
    if (!match) continue;

    const baseIndent = match[1].length;
    const inline = match[2].trim();
    const blockLines = [];
    if (inline) blockLines.push(inline);

    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() && countIndent(line) <= baseIndent) break;
      blockLines.push(line);
    }

    blocks.push(blockLines.join('\n'));
  }

  return blocks;
}

function splitTodoItems(block) {
  const items = [];
  let current = null;

  for (const line of String(block || '').split('\n')) {
    if (/^[ \t]*-\s+(?:id\s*:|\{)/.test(line)) {
      if (current) items.push(current.join('\n'));
      current = [line];
      continue;
    }
    if (current) current.push(line);
  }
  if (current) items.push(current.join('\n'));

  return items;
}

function hasTodoField(item, key) {
  const escaped = escapeRegex(key);
  return new RegExp(`(^|[\\s,{])${escaped}\\s*:`, 'm').test(String(item || ''));
}

function extractTodoId(item, index) {
  const match = String(item || '').match(/(^|[\s,{])id\s*:\s*["']?([^"',}\]\s]+)/m);
  return match ? match[2] : `#${index + 1}`;
}

export function validateTodoSchedulingFields(yamlText) {
  const missing = [];
  const blocks = extractTodoStructureBlocks(yamlText);

  for (const block of blocks) {
    const items = splitTodoItems(block);
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const todoId = extractTodoId(item, index);
      for (const field of ['depends_on', 'files_to_modify', 'resource_locks']) {
        if (!hasTodoField(item, field)) {
          missing.push(`phase_seed.mini_plan_seed.todo_structure[${todoId}].${field}`);
        }
      }
    }
  }

  return missing;
}

/**
 * Validate Phase Seed YAML against required schema.
 */
export function validateSeed(yamlText, options = {}) {
  const missing = [];
  const warnings = [];

  if (!hasNonEmptyString(yamlText, 'goal')) {
    missing.push('phase_seed.goal');
  }
  if (!hasNonEmptyArray(yamlText, 'acceptance_criteria')) {
    missing.push('phase_seed.acceptance_criteria');
  }
  if (!hasNonEmptyArray(yamlText, 'todo_structure')) {
    missing.push('phase_seed.mini_plan_seed.todo_structure');
  }

  missing.push(...validateTodoSchedulingFields(yamlText));

  if (!hasNonEmptyArray(yamlText, 'exit_conditions')) {
    missing.push('phase_seed.exit_conditions');
  }

  if (options.hasContractFiles) {
    if (!hasYamlField(yamlText, 'phase_seed.contract_snippet')) {
      missing.push('phase_seed.contract_snippet');
    } else {
      const inboundKeys = extractMappingKeys(yamlText, 'inbound');
      const outboundKeys = extractMappingKeys(yamlText, 'outbound');

      if (inboundKeys.length === 0 && outboundKeys.length === 0) {
        missing.push('phase_seed.contract_snippet.inbound|outbound (at least one must have keys)');
      }

      const inboundValidation = validateMappingValues(yamlText, 'inbound');
      if (!inboundValidation.valid) {
        warnings.push(`contract_snippet.inbound: non-string values for keys: ${inboundValidation.invalidKeys.join(', ')}`);
      }

      const outboundValidation = validateMappingValues(yamlText, 'outbound');
      if (!outboundValidation.valid) {
        warnings.push(`contract_snippet.outbound: non-string values for keys: ${outboundValidation.invalidKeys.join(', ')}`);
      }
    }
  }

  return {
    valid: missing.length === 0 && warnings.length === 0,
    missing,
    warnings,
  };
}

export function hasContractFilesContext(promptText) {
  if (!promptText) return false;
  return /contract_files\s*[:=]/.test(promptText) ||
    /contract_files.*\[/.test(promptText) ||
    /\.mpl\/contracts\//.test(promptText);
}

export function isSeedRelated(toolName, toolInput, responseText) {
  if (isFileWriteTool(toolName)) {
    if (collectFileWrites(toolInput).some((entry) => SEED_PATH_RE.test(entry.filePath))) {
      return true;
    }
  }
  if (['Task', 'task', 'Agent', 'agent'].includes(toolName)) {
    if (responseText && /phase_seed\s*:/.test(responseText) && /```ya?ml/i.test(responseText)) {
      return true;
    }
  }
  return false;
}

function buildSeedFailureMessage(issuesBlocks) {
  const body = issuesBlocks.join('\n\n');
  return `<system-reminder>
[MPL SEED VALIDATION FAILED] Phase Seed output failed schema validation.

${body}

ACTION REQUIRED: Regenerate the Phase Seed targeting the missing/invalid fields.
Do NOT proceed to Phase Runner until all required Seed fields are present and valid.
</system-reminder>`;
}

function buildSeedMissingYamlMessage() {
  return `<system-reminder>
[MPL SEED VALIDATION FAILED] Seed output does not contain a YAML block.

Expected output format: \`\`\`yaml ... \`\`\` fenced block containing phase_seed specification.

Missing: entire YAML output

ACTION REQUIRED: Regenerate the Phase Seed with valid YAML structure.
Do NOT proceed to Phase Runner until a valid Phase Seed is produced.
</system-reminder>`;
}

/**
 * Handle seed-related PostToolUse events. Never blocks; emits an advisory
 * system-reminder via additionalContext when the seed is malformed.
 *
 * ctx: { toolName, toolInput, toolResponse, cwd, mplActive }
 */
export function handleSeedSchema(ctx = {}) {
  const { toolName, toolInput, toolResponse, cwd, mplActive } = ctx;

  const responseText = typeof toolResponse === 'string'
    ? toolResponse
    : (toolResponse ? JSON.stringify(toolResponse) : '');

  if (!isSeedRelated(toolName, toolInput, responseText)) {
    return noop({ ruleId: 'seed_irrelevant' });
  }
  if (!mplActive) {
    return noop({ ruleId: 'seed_mpl_inactive' });
  }

  // Extract YAML for validation: file-write tools pass raw YAML; agent
  // outputs are markdown-fenced.
  let textToValidate = responseText;
  if (isFileWriteTool(toolName)) {
    const seedTexts = collectFileWrites(toolInput)
      .filter((entry) => SEED_PATH_RE.test(entry.filePath))
      .map((entry) => entry.text)
      .filter(Boolean);
    textToValidate = seedTexts.join('\n') || responseText;
    if (textToValidate && !textToValidate.includes('```yaml')) {
      textToValidate = '```yaml\n' + textToValidate + '\n```';
    }
  }

  const yamlText = extractYaml(textToValidate);

  if (!yamlText) {
    return advisory({
      ruleId: 'seed_missing_yaml',
      code: 'seed_missing_yaml_block',
      artifact: '.mpl/mpl/phases/*/phase-seed.yaml',
      reason: 'Seed output does not contain a YAML block.',
      additionalContext: buildSeedMissingYamlMessage(),
    });
  }

  const sideEffects = [];

  // Quality-signal side-effect (#238). Telemetry only — never blocks.
  const ambiguityGap = detectSeedAmbiguityNotesGap(yamlText);
  if (ambiguityGap) {
    try {
      recordQualitySignal(
        {
          rule: 'seed-ambiguity-notes',
          severity: 'warn',
          agent: toolName,
          evidence: ambiguityGap,
        },
        cwd,
      );
      sideEffects.push({
        kind: 'quality_signal',
        rule: 'seed-ambiguity-notes',
      });
    } catch { /* fail-soft */ }
  }

  const promptText = (toolInput && (toolInput.prompt || toolInput.description)) || '';
  const hasContracts = hasContractFilesContext(promptText);

  const result = validateSeed(yamlText, { hasContractFiles: hasContracts });

  if (result.valid) {
    return allow({
      ruleId: 'seed_schema_ok',
      sideEffects,
    });
  }

  const issuesBlocks = [];
  if (result.missing.length > 0) {
    issuesBlocks.push(
      `Missing required fields:\n${result.missing.map((f) => `  - ${f}`).join('\n')}`,
    );
  }
  if (result.warnings.length > 0) {
    issuesBlocks.push(
      `Validation warnings:\n${result.warnings.map((w) => `  - ${w}`).join('\n')}`,
    );
  }
  const message = buildSeedFailureMessage(issuesBlocks);

  return advisory({
    ruleId: 'seed_schema_invalid',
    code: 'seed_schema_invalid',
    artifact: '.mpl/mpl/phases/*/phase-seed.yaml',
    reason: 'Seed missing required fields or has invalid contract_snippet.',
    additionalContext: message,
    sideEffects,
  });
}

// ============================================================================
// (4) PROPERTY AUDIT — handlePropertyAudit
// ============================================================================

/**
 * CLI-mode audit. Pure observation: returns the declaration/used/unused
 * partition for one or more config files relative to a plugin root.
 *
 * ctx: { pluginRoot, configPaths? }
 */
export function handlePropertyAudit(ctx = {}) {
  const { pluginRoot } = ctx;
  if (!pluginRoot || typeof pluginRoot !== 'string') {
    return report({
      error: 'pluginRoot is required for property audit',
    });
  }

  const configPaths = Array.isArray(ctx.configPaths) && ctx.configPaths.length > 0
    ? ctx.configPaths
    : DEFAULT_CONFIG_TARGETS;

  const results = runPropertyBatch(pluginRoot, configPaths);
  const summary = {
    plugin_root: pluginRoot,
    configs: results,
    totals: {
      declarations: results.reduce((n, r) => n + r.declarations.length, 0),
      used: results.reduce((n, r) => n + r.used.length, 0),
      unused: results.reduce((n, r) => n + r.unused.length, 0),
    },
  };

  return report(summary);
}

// ============================================================================
// Top-level dispatch
// ============================================================================

/**
 * @param {'pivot_points_schema'|'agent_output_schema'|'seed_schema'|'property_audit'} event
 * @param {object} ctx
 */
export function handle(event, ctx = {}) {
  switch (event) {
    case 'pivot_points_schema': return handlePivotPointsSchema(ctx);
    case 'agent_output_schema': return handleAgentOutputSchema(ctx);
    case 'seed_schema':         return handleSeedSchema(ctx);
    case 'property_audit':      return handlePropertyAudit(ctx);
    default:
      throw new Error(`policy/schemas.mjs: unknown event '${event}'`);
  }
}

// Re-export L1 helpers the wrappers commonly need.
export { isMplActive };
