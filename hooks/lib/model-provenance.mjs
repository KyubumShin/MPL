/**
 * exp25 — model provenance stamping (thin-harness-visual.html roadmap 01).
 *
 * MPL indirects models through tier aliases (agent frontmatter `model: opus`),
 * so a new model is picked up automatically — but the swap is SILENT: when
 * behavior drifts you cannot tell whether the model changed. The doc's minimal
 * fix is "alias + provenance stamping": record the resolved model ID per run and,
 * when it differs from the previously stamped run, surface a drift-smoke advisory.
 * (A runtime model catalog is rejected as over-design for 9 alias-only agents.)
 *
 * The resolved model is read from the session transcript (Claude Code passes
 * transcript_path to hooks; each assistant line carries message.model). A
 * transcript-blind host (cmux split) simply won't stamp — acceptable, that's the
 * experimental harness, not the target use case.
 *
 * Both functions are side-effect-light and unit-testable; the engine wires them
 * on Stop, persists `mutation` via writeState, and appends `advisory` to the
 * Stop envelope.
 */

import { statSync, openSync, readSync, closeSync } from 'fs';

/**
 * Tail-read the transcript and return the most recent assistant message's model.
 * Bounded (reads only the last `maxBytes`) and fully fail-safe (null on any error).
 * @returns {string|null}
 */
export function readLastAssistantModel(transcriptPath, maxBytes = 131072) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return null;
  let fd;
  try {
    const { size } = statSync(transcriptPath);
    if (!size) return null;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    fd = openSync(transcriptPath, 'r');
    readSync(fd, buf, 0, len, start);
    const text = buf.toString('utf-8');
    const lines = text.split('\n');
    // Scan bottom-up: the last complete assistant line wins. The first line in
    // the window may be truncated → JSON.parse fails → skipped harmlessly.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.length < 2 || line[0] !== '{') continue;
      if (!line.includes('"assistant"')) continue; // cheap pre-filter
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj && obj.type === 'assistant' && obj.message && typeof obj.message.model === 'string') {
        const m = obj.message.model.trim();
        if (m) return m;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}

/**
 * PURE. Compare the just-resolved model to the previously stamped one.
 * @param {object|null} prev  state.model_provenance
 * @param {string} model      resolved model ID for this run
 * @param {string} nowIso     timestamp (engine passes new Date().toISOString())
 * @returns {{mutation: object|null, advisory: string|null}}
 *   mutation: a state patch to persist (null when stable → no write churn)
 *   advisory: a drift-smoke message (null on first stamp / when stable)
 */
export function computeModelProvenance(prev, model, nowIso) {
  if (!model || typeof model !== 'string') return { mutation: null, advisory: null };
  const prevCurrent = (prev && typeof prev === 'object' && typeof prev.current === 'string')
    ? prev.current : null;
  if (prevCurrent === model) return { mutation: null, advisory: null }; // stable → no write
  const mutation = {
    model_provenance: { current: model, previous: prevCurrent, changed_at: nowIso || null },
  };
  const advisory = prevCurrent
    ? `[MPL model-provenance] Resolved model changed since the last stamped run: `
      + `${prevCurrent} → ${model}. Recommend a drift smoke check (re-run a Hard Gate) — `
      + `a silent model swap can drift behavior with no explicit version event.`
    : null; // first stamp records the baseline; nothing to compare yet
  return { mutation, advisory };
}
