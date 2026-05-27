/**
 * Structured mpl-test-agent evidence helpers.
 *
 * AD-0007 originally tracked only that a test-agent dispatch happened. exp21
 * showed that dispatch existence is too weak: Hard 2 must know whether the
 * independent verifier produced valid JSON, ran executable tests, and returned
 * a clean verdict.
 */

function normalizeStatus(value) {
  return String(value || '').trim().toUpperCase();
}

// Keep enough context for debugging while preventing large sharded verifier
// responses from bloating .mpl/state.json.
export const TEST_AGENT_EVIDENCE_PREVIEW_LIMIT = 20;
export const TEST_AGENT_RESPONSE_PREVIEW_LIMIT = 600;

function firstJsonCandidate(text) {
  if (typeof text !== 'string') return null;
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

function parseResponseJson(responseText) {
  if (responseText && typeof responseText === 'object' && !Array.isArray(responseText)) {
    if (responseText.test_results || responseText.phase_id) {
      return { valid: true, value: responseText };
    }
    const nested = responseText.content ?? responseText.output ?? responseText.response ?? responseText.text;
    if (typeof nested === 'string') return parseResponseJson(nested);
    return { valid: false, value: null, reason: 'missing_test_agent_fields' };
  }
  const candidate = firstJsonCandidate(String(responseText || ''));
  if (!candidate) return { valid: false, value: null, reason: 'missing_json_block' };
  try {
    return { valid: true, value: JSON.parse(candidate) };
  } catch {
    return { valid: false, value: null, reason: 'invalid_json' };
  }
}

function numeric(value, fallback = null) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function commandExitCodes(body) {
  const commands = Array.isArray(body?.commands_run) ? body.commands_run : [];
  return commands
    .map((c) => numeric(c?.exit_code ?? c?.exitCode, null))
    .filter((n) => n !== null);
}

function boundedPreview(values, limit = TEST_AGENT_EVIDENCE_PREVIEW_LIMIT) {
  const items = Array.isArray(values) ? values : [];
  return {
    preview: items.slice(0, limit),
    count: items.length,
    truncated: items.length > limit,
  };
}

function responsePreview(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= TEST_AGENT_RESPONSE_PREVIEW_LIMIT) return clean;
  return `${clean.slice(0, TEST_AGENT_RESPONSE_PREVIEW_LIMIT - 20).trimEnd()}... [truncated]`;
}

function coverageStatuses(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => normalizeStatus(r?.status)).filter(Boolean);
}

export function parseTestAgentEvidence({
  phaseId,
  prompt = '',
  response,
  anomaly = null,
  timestamp = new Date().toISOString(),
} = {}) {
  const responseText = typeof response === 'string' ? response : JSON.stringify(response || '');
  const parsed = parseResponseJson(response);
  const anomalyReason = anomaly?.type ? 'empty_response_anomaly' : null;
  const base = {
    timestamp,
    prompt_len: String(prompt || '').length,
    response_len: responseText.length,
    response_preview: responsePreview(responseText),
    valid_json: parsed.valid,
    verdict: 'INVALID',
    phase_id: phaseId || null,
    tests_total: null,
    tests_passed: null,
    tests_failed: null,
    tests_skipped: null,
    pass_rate: null,
    test_files_created: [],
    test_files_created_count: 0,
    test_files_created_truncated: false,
    command_exit_codes: [],
    command_exit_codes_count: 0,
    command_exit_codes_nonzero_count: 0,
    command_exit_codes_truncated: false,
    bugs_found_count: null,
    invalid_reason: anomalyReason || parsed.reason || null,
    subagent_anomaly_type: anomaly?.type || null,
  };

  if (!parsed.valid) return base;

  const body = parsed.value || {};
  const results = body.test_results || {};
  const testFiles = Array.isArray(body.test_files_created) ? body.test_files_created : [];
  const commands = commandExitCodes(body);
  const bugs = Array.isArray(body.bugs_found) ? body.bugs_found : [];
  const aStatuses = coverageStatuses(body.a_item_coverage);
  const sStatuses = coverageStatuses(body.s_item_coverage);
  const testFilePreview = boundedPreview(testFiles);
  const commandExitPreview = boundedPreview(commands);
  const commandNonzeroCount = commands.filter((code) => code !== 0).length;

  const evidence = {
    ...base,
    phase_id: body.phase_id || phaseId || null,
    tests_total: numeric(results.total, 0),
    tests_passed: numeric(results.passed, 0),
    tests_failed: numeric(results.failed, 0),
    tests_skipped: numeric(results.skipped, 0),
    pass_rate: numeric(results.pass_rate, null),
    test_files_created: testFilePreview.preview,
    test_files_created_count: testFilePreview.count,
    test_files_created_truncated: testFilePreview.truncated,
    command_exit_codes: commandExitPreview.preview,
    command_exit_codes_count: commandExitPreview.count,
    command_exit_codes_nonzero_count: commandNonzeroCount,
    command_exit_codes_truncated: commandExitPreview.truncated,
    bugs_found_count: bugs.length,
    invalid_reason: null,
  };

  const issues = [];
  if (phaseId && body.phase_id && body.phase_id !== phaseId) issues.push('phase_id_mismatch');
  if (evidence.tests_total <= 0) issues.push('no_executable_tests');
  if (evidence.tests_failed > 0) issues.push('failed_tests');
  if (evidence.tests_skipped > 0) issues.push('skipped_tests');
  if (testFiles.length === 0) issues.push('missing_test_files');
  if (commands.length === 0) issues.push('missing_command_exit_codes');
  if (commands.some((code) => code !== 0)) issues.push('nonzero_command_exit_code');
  if (bugs.length > 0) issues.push('bugs_found');
  if (aStatuses.some((s) => s !== 'PASS')) issues.push('a_item_not_pass');
  if (sStatuses.some((s) => s !== 'PASS')) issues.push('s_item_not_pass');
  if (!body.verdict) issues.push('missing_verdict');
  if (body.verdict && normalizeStatus(body.verdict) !== 'PASS') issues.push('reported_non_pass_verdict');

  if (issues.length > 0) {
    evidence.verdict = issues.includes('phase_id_mismatch') ||
      issues.includes('missing_command_exit_codes') ||
      issues.includes('missing_verdict')
      ? 'INVALID'
      : 'FAIL';
    evidence.invalid_reason = issues.join(',');
    return evidence;
  }

  evidence.verdict = 'PASS';
  return evidence;
}

function commandExitCodesPass(evidence) {
  const counted = numeric(evidence?.command_exit_codes_count, null);
  const nonzeroCount = numeric(evidence?.command_exit_codes_nonzero_count, null);
  return counted > 0 && nonzeroCount === 0;
}

export function isPassingTestAgentEvidence(evidence) {
  const testFilesCreatedCount = numeric(evidence?.test_files_created_count, null);
  return Boolean(
    evidence &&
    evidence.valid_json === true &&
    evidence.verdict === 'PASS' &&
    (evidence.invalid_reason === null || evidence.invalid_reason === undefined) &&
    typeof evidence.tests_total === 'number' &&
    evidence.tests_total > 0 &&
    typeof evidence.tests_failed === 'number' &&
    evidence.tests_failed === 0 &&
    typeof evidence.tests_skipped === 'number' &&
    evidence.tests_skipped === 0 &&
    testFilesCreatedCount > 0 &&
    commandExitCodesPass(evidence) &&
    evidence.bugs_found_count === 0
  );
}
