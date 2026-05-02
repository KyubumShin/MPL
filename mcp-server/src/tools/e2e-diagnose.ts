/**
 * MCP Tool: mpl_diagnose_e2e_failure
 *
 * 0.16 Tier C classifier. Orchestrator calls this conditionally from Finalize
 * when every required scenario ran but one or more failed AND user-contract UC
 * coverage is complete. Returns a classification + fix strategy JSON that the
 * orchestrator then acts on (append phases / re-test-agent / re-Step-1.5 /
 * rerun).
 *
 * Budget: expected cost <= 1 opus call per finalize failure. Circuit breaker
 * (state.e2e_recovery.iter, max=2) caps total diagnose calls per pipeline.
 */

import {
  appendRecoveryMetric,
  diagnoseE2EFailure,
  PROMPT_VERSION,
} from '../lib/e2e-diagnoser.js';

export const diagnoseE2EFailureTool = {
  name: 'mpl_diagnose_e2e_failure',
  description:
    'Classify a failing E2E run as A=spec gap / B=test bug / C=missing capability / D=flake and return a fix strategy. Called conditionally by Finalize (Tier C UC coverage complete + E2E fail). Max 2 invocations per pipeline (circuit breaker).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      cwd: { type: 'string', description: 'Project root directory' },
      scenarios: {
        type: 'string',
        description: 'Contents of .mpl/mpl/e2e-scenarios.yaml',
      },
      e2e_results: {
        type: 'string',
        description:
          'JSON of state.e2e_results (scenario_id → { exit_code, stdout_tail, stderr_tail, trace_path? })',
      },
      trace_excerpt: {
        type: 'string',
        description:
          'Concatenated failing-scenario trace excerpts (best-effort, 4KB max). Orchestrator prepares from trace files.',
      },
      user_contract: {
        type: 'string',
        description: 'Contents of .mpl/requirements/user-contract.md',
      },
      decomposition: {
        type: 'string',
        description: 'Contents of .mpl/mpl/decomposition.yaml',
      },
      prev_iter: {
        type: 'number',
        description:
          'state.e2e_recovery.iter before this call. Used for iter_hint bookkeeping.',
      },
    },
    required: [
      'cwd',
      'scenarios',
      'e2e_results',
      'trace_excerpt',
      'user_contract',
      'decomposition',
      'prev_iter',
    ],
  },
};

export async function handleDiagnoseE2EFailure(args: {
  cwd: string;
  scenarios: string;
  e2e_results: string;
  trace_excerpt: string;
  user_contract: string;
  decomposition: string;
  prev_iter: number;
}) {
  const prev_iter = Math.max(0, Math.min(2, Math.floor(args.prev_iter)));
  const result = await diagnoseE2EFailure(
    {
      scenarios: args.scenarios,
      e2e_results: args.e2e_results,
      trace_excerpt: args.trace_excerpt,
      user_contract: args.user_contract,
      decomposition: args.decomposition,
      prev_iter,
    },
    { cwd: args.cwd },
  );

  const ordered = {
    prompt_version: PROMPT_VERSION,
    prev_iter,
    classification: result.classification,
    root_cause: result.root_cause,
    fix_strategy: result.fix_strategy,
    iter_hint: result.iter_hint,
    trace_excerpt: result.trace_excerpt,
    append_phases: result.append_phases,
    confidence: result.confidence,
  };

  appendRecoveryMetric(args.cwd, {
    ts: new Date().toISOString(),
    classification: result.classification,
    confidence: result.confidence,
    iter: prev_iter + result.iter_hint,
    prompt_version: PROMPT_VERSION,
  });

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(ordered, null, 2) }],
  };
}
