import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { readState, writeState } from './mpl-state.mjs';
import { recordTelemetryError } from './mpl-profile.mjs';

export const SUBAGENT_RETURN_ANOMALY_LIMIT = 20;
const PROFILE_FILE = 'subagent-return-anomalies.jsonl';

function numeric(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringField(value) {
  return typeof value === 'string' ? value : null;
}

function textFromContentArray(content) {
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const item of content) {
    if (typeof item === 'string') {
      parts.push(item);
      continue;
    }
    if (isPlainObject(item) && typeof item.text === 'string') {
      parts.push(item.text);
    }
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

export function extractFinalResponseText(toolResponse) {
  if (typeof toolResponse === 'string') return toolResponse;
  if (!isPlainObject(toolResponse)) return '';

  const direct = stringField(toolResponse.text)
    ?? stringField(toolResponse.response)
    ?? stringField(toolResponse.output)
    ?? stringField(toolResponse.stdout)
    ?? stringField(toolResponse.message)
    ?? stringField(toolResponse.final_response)
    ?? stringField(toolResponse.finalResponse)
    ?? stringField(toolResponse.result);
  if (direct !== null) return direct;

  const contentText = typeof toolResponse.content === 'string'
    ? toolResponse.content
    : textFromContentArray(toolResponse.content);
  if (contentText !== null) return contentText;

  // A structured test-agent object is a real final response. Metadata-only
  // objects are intentionally not stringified here; they represent "no final
  // assistant text" for the anomaly detector.
  if (toolResponse.phase_id || toolResponse.test_results || toolResponse.verdict) {
    try {
      return JSON.stringify(toolResponse);
    } catch {
      return '';
    }
  }
  return '';
}

function findNumericByKey(value, keys, depth = 0) {
  if (!value || depth > 4) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNumericByKey(item, keys, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  if (!isPlainObject(value)) return null;

  for (const key of keys) {
    const found = numeric(value[key]);
    if (found !== null) return found;
  }
  for (const item of Object.values(value)) {
    const found = findNumericByKey(item, keys, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

export function extractPhaseId(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(/\bphase[-\s]?(\d+)\b/i);
  return match ? `phase-${match[1]}` : null;
}

export function extractSubagentMetrics(data = {}) {
  const toolResponse = data.tool_response ?? data.toolResponse ?? {};
  const searchRoot = { data, toolResponse };
  return {
    output_tokens: findNumericByKey(searchRoot, [
      'output_tokens',
      'outputTokens',
      'completion_tokens',
      'completionTokens',
      'generated_tokens',
      'generatedTokens',
    ]),
    tools_used: findNumericByKey(searchRoot, [
      'tools_used',
      'toolsUsed',
      'tool_count',
      'toolCount',
      'tool_calls',
      'toolCalls',
      'num_tools',
      'numTools',
    ]),
    duration_ms: findNumericByKey(searchRoot, [
      'duration_ms',
      'durationMs',
      'elapsed_ms',
      'elapsedMs',
      'latency_ms',
      'latencyMs',
    ]),
  };
}

export function detectSubagentReturnAnomaly({
  data = {},
  agentType = '',
  phaseId = null,
  finalResponseText = null,
} = {}) {
  const toolName = String(data.tool_name || data.toolName || '');
  if (!['Task', 'task', 'Agent', 'agent'].includes(toolName)) return null;

  const toolInput = data.tool_input || data.toolInput || {};
  const resolvedAgentType = agentType || String(toolInput.subagent_type || toolInput.subagentType || '');
  const resolvedPhaseId = phaseId || extractPhaseId(toolInput.prompt || toolInput.description || '');
  const toolResponse = data.tool_response ?? data.toolResponse ?? '';
  const responseText = finalResponseText === null
    ? extractFinalResponseText(toolResponse)
    : String(finalResponseText || '');
  const responseLen = responseText.length;
  const responseBlank = responseText.trim().length === 0;
  const metrics = extractSubagentMetrics(data);
  const toolsUsed = metrics.tools_used;
  const outputTokens = metrics.output_tokens;
  const durationMs = metrics.duration_ms;
  const substantialToolUse = typeof toolsUsed === 'number' && toolsUsed >= 5;
  const longDuration = typeof durationMs === 'number' && durationMs >= 5 * 60 * 1000;
  const zeroOutput = outputTokens === 0;

  let type = null;
  if (responseBlank && substantialToolUse) {
    type = zeroOutput ? 'zero_token_after_tools' : 'empty_response_after_tools';
  } else if (responseBlank && (zeroOutput || longDuration)) {
    type = 'agent_init_failure';
  } else if (responseBlank) {
    type = 'empty_response';
  } else if (zeroOutput && (substantialToolUse || longDuration)) {
    type = 'zero_token_after_tools';
  }

  if (!type) return null;

  return {
    timestamp: new Date().toISOString(),
    type,
    agent_type: resolvedAgentType || null,
    phase_id: resolvedPhaseId,
    response_len: responseLen,
    output_tokens: outputTokens,
    tools_used: toolsUsed,
    duration_ms: durationMs,
    recommendation: recommendationFor(type, resolvedAgentType),
  };
}

function recommendationFor(type, agentType) {
  if (/mpl-test-agent$/.test(agentType || '')) {
    return 'Re-dispatch mpl-test-agent and require a fenced JSON evidence block.';
  }
  if (type === 'agent_init_failure') {
    return 'Re-dispatch the subagent; no meaningful work was reported.';
  }
  return 'Verify on-disk artifacts directly, then re-dispatch the subagent if the phase cannot be proven complete.';
}

export function appendSubagentReturnAnomaly(cwd, anomaly) {
  if (!anomaly) return;
  try {
    const state = readState(cwd);
    if (state) {
      const prior = Array.isArray(state.subagent_return_anomalies)
        ? state.subagent_return_anomalies
        : [];
      writeState(cwd, {
        subagent_return_anomalies: [...prior, anomaly].slice(-SUBAGENT_RETURN_ANOMALY_LIMIT),
      });
    }
  } catch (err) {
    recordTelemetryError(cwd, 'mpl-subagent-anomaly:writeState', err, {
      agent_type: anomaly.agent_type || null,
      phase_id: anomaly.phase_id || null,
      type: anomaly.type || null,
    });
  }

  try {
    const profileDir = join(cwd, '.mpl/mpl/profile');
    if (!existsSync(profileDir)) mkdirSync(profileDir, { recursive: true });
    appendFileSync(join(profileDir, PROFILE_FILE), JSON.stringify(anomaly) + '\n');
  } catch (err) {
    recordTelemetryError(cwd, 'mpl-subagent-anomaly:profile', err, {
      agent_type: anomaly.agent_type || null,
      phase_id: anomaly.phase_id || null,
      type: anomaly.type || null,
    });
  }
}

export function formatSubagentAnomalyMessage(anomaly) {
  if (!anomaly) return '';
  const parts = [
    `[MPL SUBAGENT RETURN ANOMALY] ${anomaly.agent_type || 'subagent'} returned ${anomaly.type}.`,
    `phase=${anomaly.phase_id || 'unknown'}`,
    `response_len=${anomaly.response_len}`,
  ];
  if (typeof anomaly.output_tokens === 'number') parts.push(`output_tokens=${anomaly.output_tokens}`);
  if (typeof anomaly.tools_used === 'number') parts.push(`tools_used=${anomaly.tools_used}`);
  if (typeof anomaly.duration_ms === 'number') parts.push(`duration_ms=${anomaly.duration_ms}`);
  parts.push(`Recommendation: ${anomaly.recommendation}`);
  return parts.join(' ');
}
