import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  appendSubagentReturnAnomaly,
  detectSubagentReturnAnomaly,
  extractFinalResponseText,
  formatSubagentAnomalyMessage,
} from '../lib/mpl-subagent-anomaly.mjs';
import { CURRENT_SCHEMA_VERSION } from '../lib/mpl-state.mjs';

function taskPayload({ response = '', toolsUsed = null, outputTokens = null, durationMs = null } = {}) {
  return {
    cwd: '/tmp/example',
    tool_name: 'Task',
    tool_input: {
      subagent_type: 'mpl-phase-runner',
      prompt: 'Run phase-19.',
    },
    tool_response: {
      text: response,
      usage: { output_tokens: outputTokens },
      metrics: { tools_used: toolsUsed, duration_ms: durationMs },
    },
  };
}

describe('mpl-subagent-anomaly', () => {
  it('extracts final text from common Task response shapes', () => {
    assert.equal(extractFinalResponseText('done'), 'done');
    assert.equal(extractFinalResponseText({ text: 'done' }), 'done');
    assert.equal(extractFinalResponseText({ content: [{ type: 'text', text: 'done' }] }), 'done');
    assert.equal(extractFinalResponseText({ usage: { output_tokens: 0 } }), '');
  });

  it('detects empty response after substantial tool use', () => {
    const anomaly = detectSubagentReturnAnomaly({
      data: taskPayload({ response: '', toolsUsed: 58, outputTokens: 0, durationMs: 55 * 60 * 1000 }),
    });
    assert.equal(anomaly.type, 'zero_token_after_tools');
    assert.equal(anomaly.phase_id, 'phase-19');
    assert.equal(anomaly.tools_used, 58);
    assert.equal(anomaly.output_tokens, 0);
    assert.match(formatSubagentAnomalyMessage(anomaly), /zero_token_after_tools/);
  });

  it('detects init failure when empty response has zero output and no tool use', () => {
    const anomaly = detectSubagentReturnAnomaly({
      data: taskPayload({ response: '', toolsUsed: 0, outputTokens: 0, durationMs: 30_000 }),
    });
    assert.equal(anomaly.type, 'agent_init_failure');
  });

  it('does not flag normal non-empty responses', () => {
    const anomaly = detectSubagentReturnAnomaly({
      data: taskPayload({ response: 'phase complete', toolsUsed: 10, outputTokens: 25 }),
    });
    assert.equal(anomaly, null);
  });

  it('records anomalies in state and profile JSONL', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mpl-anomaly-'));
    try {
      mkdirSync(join(tmp, '.mpl'), { recursive: true });
      writeFileSync(join(tmp, '.mpl', 'state.json'), JSON.stringify({
        schema_version: CURRENT_SCHEMA_VERSION,
        current_phase: 'phase2-sprint',
      }));
      const anomaly = {
        timestamp: '2026-05-27T00:00:00.000Z',
        type: 'zero_token_after_tools',
        agent_type: 'mpl-phase-runner',
        phase_id: 'phase-19',
        response_len: 0,
        output_tokens: 0,
        tools_used: 58,
        duration_ms: 123,
        recommendation: 'verify',
      };
      appendSubagentReturnAnomaly(tmp, anomaly);
      const state = JSON.parse(readFileSync(join(tmp, '.mpl', 'state.json'), 'utf-8'));
      assert.equal(state.subagent_return_anomalies.length, 1);
      assert.equal(state.subagent_return_anomalies[0].type, 'zero_token_after_tools');
      const profile = readFileSync(
        join(tmp, '.mpl', 'mpl', 'profile', 'subagent-return-anomalies.jsonl'),
        'utf-8',
      );
      assert.match(profile, /zero_token_after_tools/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
