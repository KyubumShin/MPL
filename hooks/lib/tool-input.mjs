/**
 * Helpers for Claude/Codex file-write tool input shapes.
 *
 * Write/Edit expose a single `file_path` plus `content` or `new_string`.
 * MultiEdit may expose a top-level `file_path` with `edits[]`, or per-edit
 * `file_path` entries. Guards should treat all of those as write targets.
 */

export function isFileWriteTool(toolName) {
  return ['Write', 'write', 'Edit', 'edit', 'MultiEdit', 'multiEdit', 'multiedit']
    .includes(String(toolName || ''));
}

function proposedText(input) {
  if (!input || typeof input !== 'object') return '';
  for (const key of ['content', 'new_string', 'newString']) {
    if (typeof input[key] === 'string') return input[key];
  }
  return '';
}

export function collectFileWrites(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return [];

  const topPath = toolInput.file_path || toolInput.filePath || '';
  const entries = [];
  const topText = proposedText(toolInput);
  if (topPath || topText) entries.push({ filePath: topPath, text: topText });

  if (Array.isArray(toolInput.edits)) {
    for (const edit of toolInput.edits) {
      if (!edit || typeof edit !== 'object') continue;
      const filePath = edit.file_path || edit.filePath || topPath || '';
      entries.push({ filePath, text: proposedText(edit) });
    }
  }

  return entries;
}

export function collectTargetPaths(toolInput) {
  return collectFileWrites(toolInput)
    .map((entry) => entry.filePath)
    .filter(Boolean);
}
