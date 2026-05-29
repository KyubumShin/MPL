/**
 * Quality-signal telemetry surface.
 *
 * Some MUSTs / SHOULDs in MPL agent prompts are real quality concerns
 * but pattern-matching them is heuristic and the false-positive rate is
 * meaningful. Blocking on them would over-enforce; ignoring them loses
 * the signal entirely. This module is the middle path: append a
 * structured record per soft-signal hit to `.mpl/mpl/quality-signals.jsonl`
 * so violations are countable across runs, surfaced in `mpl-doctor`,
 * and reviewable without blocking the pipeline.
 *
 * See:
 *   - `docs/findings/2026-05-28-enforcement-relaxation-plan.md` §A
 *   - Issue #238
 *
 * Per-record schema:
 *   { rule, severity, ts, phase, agent, evidence }
 *
 * - `rule`     — stable identifier (e.g. "HA-01", "seed-ambiguity-notes")
 * - `severity` — "warn" (default) | "info"
 * - `ts`       — ISO-8601 UTC timestamp
 * - `phase`    — current_phase from state.json, or null
 * - `agent`    — subagent_type / tool_name that triggered the signal
 * - `evidence` — rule-specific structured payload (e.g. matched phrase + offset)
 *
 * This module is fail-soft: any IO error appending the record is
 * swallowed (the calling hook should not be blocked on telemetry).
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';

const SIGNALS_REL = ['.mpl', 'mpl', 'quality-signals.jsonl'];

export function signalsLogPath(cwd) {
  return join(cwd, ...SIGNALS_REL);
}

function readCurrentPhase(cwd) {
  try {
    const statePath = join(cwd, '.mpl', 'state.json');
    if (!existsSync(statePath)) return null;
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    return state?.current_phase ?? state?.execution?.current_phase ?? null;
  } catch {
    return null;
  }
}

/**
 * Append a quality-signal record. Returns true if the record was
 * written, false if any IO error swallowed the write.
 *
 * @param {object} record
 * @param {string} record.rule        Stable rule id (e.g. "HA-01")
 * @param {string} [record.severity]  "warn" (default) | "info"
 * @param {string} [record.agent]     subagent_type / tool_name
 * @param {object} [record.evidence]  Rule-specific structured payload
 * @param {string} [record.ts]        ISO timestamp (defaults to now)
 * @param {string} cwd                Workspace root
 */
export function recordQualitySignal(record, cwd) {
  if (!record || !record.rule || !cwd) return false;
  try {
    const path = signalsLogPath(cwd);
    mkdirSync(dirname(path), { recursive: true });
    const payload = {
      rule: String(record.rule),
      severity: record.severity || 'warn',
      ts: record.ts || new Date().toISOString(),
      phase: record.phase ?? readCurrentPhase(cwd),
      agent: record.agent ?? null,
      evidence: record.evidence ?? null,
    };
    appendFileSync(path, JSON.stringify(payload) + '\n');
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the quality-signal log.
 *
 * Returns `{ records, malformed }`:
 *   - `records`   — array of parsed records, in file order.
 *   - `malformed` — count of non-empty lines that failed to parse as JSON.
 *
 * Returns `{ records: [], malformed: 0 }` if the log file does not exist
 * (no signals yet — not an error).
 *
 * The `malformed` count is load-bearing for mpl-doctor Category 16
 * (#238): doctor must distinguish "log is clean" from "log has
 * unparseable lines" to surface the WARN the category promises.
 * Silently dropping malformed lines would hide the very condition the
 * diagnostic is meant to catch (codex r1 [contract-break] finding).
 */
export function readQualitySignals(cwd) {
  const path = signalsLogPath(cwd);
  if (!existsSync(path)) return { records: [], malformed: 0 };
  let text;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    // IO error on a present file is itself a degraded read condition;
    // surface it as a malformed signal so doctor warns rather than
    // reporting "clean".
    return { records: [], malformed: 1 };
  }
  const records = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      malformed += 1;
    }
  }
  return { records, malformed };
}

/**
 * Aggregate signal records into per-rule counts.
 * Returns { [rule]: count } sorted by descending count.
 */
export function summarizeQualitySignals(signals) {
  const counts = new Map();
  for (const rec of signals || []) {
    if (!rec || !rec.rule) continue;
    counts.set(rec.rule, (counts.get(rec.rule) || 0) + 1);
  }
  return Object.fromEntries(
    [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  );
}

// ---------------------------------------------------------------------------
// Rule-specific detectors
// ---------------------------------------------------------------------------

/**
 * HA-01: vague delegation prompt.
 *
 * Detects orchestrator-emitted Task/Agent prompts that delegate without
 * passing the work-load specifically. The rule lives only in the
 * `mpl-decomposer` / `mpl-phase-runner` agent prompts; here we surface
 * the pattern as a soft signal so the operator can audit how often
 * agents are dispatched with under-specified prompts.
 *
 * Returns the matched phrase + offset when a match is found, or null.
 * The match is case-insensitive and tolerant of surrounding whitespace.
 */
const HA01_PHRASES = [
  // Korean — common patterns observed in the 3-layer audit
  '이전 결과 참고',
  '이전 결과를 참고',
  '알아서 판단',
  '알아서 처리',
  '적절히 판단',
  '적당히 판단',
  '필요하면 추가',
  // English equivalents the audit doc cites
  'use your judgment',
  'use your judgement',
  'figure it out',
  'as appropriate',
  'as you see fit',
];

export function detectHa01(promptText) {
  if (!promptText || typeof promptText !== 'string') return null;
  const lower = promptText.toLowerCase();
  for (const phrase of HA01_PHRASES) {
    const idx = lower.indexOf(phrase.toLowerCase());
    if (idx >= 0) {
      return { phrase, offset: idx };
    }
  }
  return null;
}

/**
 * Seed Generator "No invention" / `ambiguity_notes` check.
 *
 * The Seed Generator prompt requires that when the agent is uncertain
 * about a phase boundary, it MUST surface that uncertainty in an
 * `ambiguity_notes` block rather than inventing acceptance criteria.
 * The signal here: when the produced seed YAML mentions uncertainty
 * vocabulary (TBD / unclear / 모르겠음 / 추정 etc.) but provides no
 * `ambiguity_notes` field, the agent has likely invented instead of
 * surfacing the gap.
 *
 * Returns { reason, matched } when the soft-signal fires, or null.
 */
const UNCERTAINTY_TOKENS = [
  '\\bTBD\\b',
  '\\bTODO\\b',
  '\\bunclear\\b',
  '\\bunknown\\b',
  '\\bestimate(?:d)?\\b',
  '추정',
  '모르겠',
  '불확실',
  '확실하지\\s*않',
];

export function detectSeedAmbiguityNotesGap(yamlText) {
  if (!yamlText || typeof yamlText !== 'string') return null;
  // If the seed already provides a non-empty ambiguity_notes block,
  // the escape hatch was used — no signal.
  if (/^\s*ambiguity_notes\s*:\s*\S/m.test(yamlText)) return null;
  if (/^\s*ambiguity_notes\s*:\s*\n\s+[-\w]/m.test(yamlText)) return null;
  const re = new RegExp(`(?:${UNCERTAINTY_TOKENS.join('|')})`, 'i');
  const m = yamlText.match(re);
  if (!m) return null;
  return { reason: 'uncertainty-without-ambiguity-notes', matched: m[0] };
}
