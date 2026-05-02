/**
 * E2E Failure Diagnoser — LLM-driven root cause + fix strategy classifier.
 *
 * Invoked from Finalize only when:
 *   (a) All required scenarios executed AND
 *   (b) Tier C UC coverage is complete AND
 *   (c) At least one scenario failed (exit_code != 0)
 *
 * Classification taxonomy:
 *   A = spec gap             (decomposer must append mini-phases)
 *   B = test bug             (test-agent re-dispatch; implementation is fine)
 *   C = missing capability   (Step 1.5 re-run in minimal mode; new UC emerged)
 *   D = flake                (rerun once with --trace on)
 *
 * PROMPT_VERSION is frozen inline so exp12 agreement-rate (auxiliary LLM
 * labeling per Q8) can gate sunset vs file-promotion decisions in Stage 4.
 */

export const PROMPT_VERSION = 'v1-2026-04-19';

const SESSION_KIND = 'e2e_diagnose';

import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCachedQuery } from './agent-sdk-query.js';
import { readState } from './state-manager.js';

export const RECOVERY_METRICS_PATH = '.mpl/metrics/e2e-recovery.jsonl';

export interface RecoveryMetricRecord {
  ts: string;
  classification: 'A' | 'B' | 'C' | 'D';
  confidence: number;
  iter: number;
  prompt_version: string;
}

/**
 * Append one structured record to `.mpl/metrics/e2e-recovery.jsonl`.
 *
 * Called by the `mpl_diagnose_e2e_failure` MCP tool handler after every
 * diagnose call so that any pipeline running E2E recovery emits a per-call
 * audit trail without requiring orchestrator-side bookkeeping. Schema is
 * stable per `docs/roadmap/0.16-exp12-plan.md` Metric 4.
 *
 * Returns true on successful append, false on any I/O failure (caller
 * should not surface metrics emission errors — diagnosis return is the
 * primary contract).
 */
export function appendRecoveryMetric(cwd: string, record: RecoveryMetricRecord): boolean {
  try {
    const metricsDir = join(cwd, '.mpl', 'metrics');
    if (!existsSync(metricsDir)) mkdirSync(metricsDir, { recursive: true });
    appendFileSync(join(cwd, RECOVERY_METRICS_PATH), JSON.stringify(record) + '\n', { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

export type Classification = 'A' | 'B' | 'C' | 'D';

export interface AppendPhaseHint {
  position: 'after' | 'before';
  anchor_phase: string;
  proposed_id: string;
  goal: string;
  covers: string[];
}

export interface DiagnosisResult {
  prompt_version: string;
  classification: Classification;
  root_cause: string;
  fix_strategy: string;
  iter_hint: number;
  trace_excerpt: string;
  append_phases: AppendPhaseHint[];
  confidence: number;
}

export interface DiagnoserInput {
  scenarios: string;
  e2e_results: string;
  trace_excerpt: string;
  user_contract: string;
  decomposition: string;
  prev_iter: number;
}

const DIAGNOSE_PROMPT = `You are the MPL E2E Failure Diagnoser.

GOAL: Given a failing E2E run context, classify the root cause and propose a fix
strategy. You do NOT write code. You produce a structured verdict that the
orchestrator and decomposer will act on.

CLASSIFICATION RULES (pick exactly one):
- A = spec gap               (implementation is missing behavior required by the
                              failing scenario; new phase(s) must be appended.
                              Fill append_phases with 1-3 hints.)
- B = test bug               (implementation behavior is correct; the test
                              itself is wrong — wrong selector, wrong assertion,
                              wrong setup. Point to the specific test.)
- C = missing capability     (the scenario exercises a UC that was not declared
                              in user-contract.md — Step 1.5 must re-run in
                              minimal mode to append the missing UC.)
- D = flake                  (non-deterministic environmental failure:
                              timing, network jitter, resource contention.
                              Rerun once with trace on.)

FIELDS:
- root_cause: 1-2 sentences, concrete, referencing specific files/symbols/lines
  from the provided context.
- fix_strategy: 1-3 sentences, actionable. For A reference append_phases.
  For B name the test file. For C name the uncovered UC. For D state the
  timing/env signal.
- iter_hint: suggested iter bump for circuit breaker (0, 1, or 2). D typically
  iter=0 (doesn't count against budget). A/B/C typically iter=1.
- trace_excerpt: 200-char max excerpt quoting the most damning trace line(s).
- append_phases: ONLY populated when classification=A. Otherwise empty array.
- confidence: 0.0..1.0, your confidence in the classification.

RESPOND ONLY WITH VALID JSON (no markdown, no prose):
{
  "classification": "A|B|C|D",
  "root_cause": "",
  "fix_strategy": "",
  "iter_hint": 1,
  "trace_excerpt": "",
  "append_phases": [],
  "confidence": 0.85
}`;

function buildUserMessage(input: DiagnoserInput): string {
  return [
    `Scenarios YAML:\n${input.scenarios}`,
    `E2E Results JSON:\n${input.e2e_results}`,
    `Trace Excerpt:\n${input.trace_excerpt}`,
    `User Contract:\n${input.user_contract}`,
    `Decomposition YAML:\n${input.decomposition}`,
    `Previous iter: ${input.prev_iter}`,
  ].join('\n\n');
}

export function parseDiagnosis(text: string): DiagnosisResult | null {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const p = JSON.parse(match[0]);

    if (!['A', 'B', 'C', 'D'].includes(p.classification)) return null;
    if (typeof p.root_cause !== 'string') return null;
    if (typeof p.fix_strategy !== 'string') return null;
    if (typeof p.iter_hint !== 'number') return null;
    if (typeof p.trace_excerpt !== 'string') return null;
    if (!Array.isArray(p.append_phases)) return null;
    if (typeof p.confidence !== 'number') return null;

    return {
      prompt_version: PROMPT_VERSION,
      classification: p.classification as Classification,
      root_cause: p.root_cause,
      fix_strategy: p.fix_strategy,
      iter_hint: Math.max(0, Math.min(2, Math.floor(p.iter_hint))),
      trace_excerpt: p.trace_excerpt.slice(0, 400),
      append_phases: p.append_phases,
      confidence: Math.max(0, Math.min(1, p.confidence)),
    };
  } catch {
    return null;
  }
}

export function neutralDiagnosis(): DiagnosisResult {
  return {
    prompt_version: PROMPT_VERSION,
    classification: 'D',
    root_cause:
      'Diagnoser LLM unavailable — defaulting to flake classification to avoid falsely appending phases.',
    fix_strategy:
      'Rerun once. If failure reproduces, escalate to manual review; do NOT auto-append phases under uncertainty.',
    iter_hint: 1,
    trace_excerpt: '',
    append_phases: [],
    confidence: 0,
  };
}

export interface DiagnoserContext {
  /** Project root (for session-cache scoping). Defaults to process.cwd(). */
  cwd?: string;
}

export async function diagnoseE2EFailure(
  input: DiagnoserInput,
  context: DiagnoserContext = {},
): Promise<DiagnosisResult> {
  const fullPrompt = `${DIAGNOSE_PROMPT}\n\nINPUT:\n${buildUserMessage(input)}`;
  const cwd = context.cwd ?? process.cwd();
  const state = readState(cwd);
  const pipelineId = state?.pipeline_id ?? 'unknown-pipeline';

  // Cache key: stable prefix only (prompt + scenarios + user_contract +
  // decomposition). Per-call inputs that change with each diagnosis attempt
  // (e2e_results, trace_excerpt, prev_iter) are excluded so retries within
  // one pipeline hit the prompt cache.
  const cacheInput = `${DIAGNOSE_PROMPT}\n${input.scenarios}\n${input.user_contract}\n${input.decomposition}`;

  const r = await runCachedQuery<DiagnosisResult>(
    {
      cwd,
      kind: SESSION_KIND,
      pipeline_id: pipelineId,
      cache_input: cacheInput,
      system_prompt: 'You are a JSON-only E2E failure diagnoser. Output only valid JSON per the schema.',
      full_prompt: fullPrompt,
    },
    parseDiagnosis,
  );

  if (r.ok) return r.value;
  return neutralDiagnosis();
}
