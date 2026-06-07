/**
 * MPL Signals (L1 observability — Move #12)
 *
 * SSOT for seven signal/recorder hooks. Each sub-handler is a pure function
 * over `ctx` and returns either a "noop" decision (no advisory, no state
 * mutation worth surfacing) or a "signal" decision (advisory string,
 * optional state patch, optional jsonl path). Callers (the 7 thin wrappers
 * in `hooks/mpl-sentinel-*.mjs`, `hooks/mpl-soft-signal-emit.mjs`,
 * `hooks/mpl-gate-recorder.mjs`, `hooks/mpl-discovery-scanner.mjs`,
 * `hooks/mpl-keyword-detector.mjs`) translate that envelope into the
 * legacy stdout shape Claude Code expects.
 *
 * The module ALSO exports the engine-facing `emit(payload)` used by
 * `mpl-engine.mjs` (Move #5) — a thin telemetry sink that today is a no-op
 * placeholder + structured-log fan-out, so the engine's `await emitSignal()`
 * step has a real, importable target.
 *
 * Public API:
 *   - handle(event, ctx) -> decision
 *   - handleSentinelS0(ctx), handleSentinelS1(ctx), handleSentinelS3(ctx),
 *     handleSentinelPPFile(ctx), handleSoftSignalEmit(ctx),
 *     handleGateRecorder(ctx), handleDiscoveryScanner(ctx),
 *     handleKeywordDetector(ctx)
 *   - emit(payload) -> { ok, sink? }   (engine bridge — fail-soft no-op
 *     when no log path is configured)
 *
 * Subagent-type gating (CLOSES THE EVAL FINDING):
 *   S1 and S3 today fire on every Task|Agent completion regardless of
 *   subagent_type, doing heavy filesystem scans for unrelated agents
 *   (debate, validate-seed, ambiguity-gate, …). This module reads the new
 *   YAML knob `observability.sentinels.subagent_type_filter` from
 *   `mpl.config.yaml` and short-circuits when the dispatching subagent_type
 *   is not in the filter. Defaults are scoped to the agents whose output
 *   the sentinel actually targets:
 *     S0  -> ['mpl-seed-generator',     'mpl:mpl-seed-generator']
 *     S1  -> ['mpl-phase-runner',       'mpl:mpl-phase-runner']
 *     S3  -> ['mpl-test-agent',         'mpl:mpl-test-agent']
 *   File-write tools (Edit/Write/MultiEdit) bypass the filter — they have
 *   no subagent_type and the existing path-based gates (e.g.
 *   `SEED_PATH_RE`) keep the work bounded.
 *
 * Dependency boundary (per hooks/lib/observability/README.md):
 *   Imports L1 helpers + config + state-reader ONLY.
 *   NEVER imports any policy/* module.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';

// ============================================================================
// Decision envelope builders
// ============================================================================

function noop({ ruleId, suppressOutput = true } = {}) {
  return {
    action: 'noop',
    ruleId: ruleId || null,
    additionalContext: null,
    systemMessage: null,
    stateMutations: null,
    suppressOutput,
  };
}

function signal({ ruleId, additionalContext = null, systemMessage = null, stateMutations = null, sink = null }) {
  return {
    action: 'signal',
    ruleId: ruleId || null,
    additionalContext: additionalContext || null,
    systemMessage: systemMessage || null,
    stateMutations: stateMutations || null,
    sink: sink || null,
    suppressOutput: !(additionalContext || systemMessage),
  };
}

// ============================================================================
// Subagent-type filter (CLOSES EVAL FINDING)
// ============================================================================

/**
 * Default allowlist per sentinel. Users override via the YAML knob:
 *   observability.sentinels.subagent_type_filter:
 *     s1: ['mpl-phase-runner']
 *     s3: ['mpl-test-agent']
 *     s0: ['mpl-seed-generator', 'mpl-phase-runner']
 *
 * To disable the filter (legacy "fire for every Task|Agent" behavior) set
 * the list to `null` or `[]`. To opt out of a specific sentinel entirely,
 * set its list to `["__none__"]`.
 */
export const SENTINEL_DEFAULT_FILTERS = Object.freeze({
  s0: Object.freeze(['mpl-seed-generator', 'mpl:mpl-seed-generator', 'mpl-phase-runner', 'mpl:mpl-phase-runner']),
  s1: Object.freeze(['mpl-phase-runner', 'mpl:mpl-phase-runner']),
  s3: Object.freeze(['mpl-test-agent', 'mpl:mpl-test-agent']),
});

/**
 * Resolve the filter list for a sentinel id from config, with defaults.
 * @param {object|null} config Loaded mpl.config.yaml / .mpl/config.json
 * @param {'s0'|'s1'|'s3'} sentinelId
 * @returns {string[]|null} list of allowed subagent_types, or null = no filter
 */
export function resolveSentinelFilter(config, sentinelId) {
  const observability = (config && config.observability) || {};
  const sentinels = observability.sentinels || {};
  const userFilter = sentinels.subagent_type_filter;
  const fromUser = userFilter && typeof userFilter === 'object'
    ? userFilter[sentinelId]
    : undefined;

  if (fromUser === null) return null;            // explicit opt-out of filtering
  if (Array.isArray(fromUser)) return [...fromUser];
  return [...SENTINEL_DEFAULT_FILTERS[sentinelId]];
}

/**
 * True when the subagent_type passes the filter (or filter is null/empty).
 * File-write tools (no subagent_type) always pass; their own path gates apply.
 */
export function subagentPassesFilter(subagentType, filterList) {
  if (filterList === null) return true;
  if (!Array.isArray(filterList) || filterList.length === 0) return true;
  if (!subagentType) return true; // file-write or unmapped: bypass — path gate handles it
  return filterList.includes(subagentType);
}

// ============================================================================
// Shared helpers
// ============================================================================

const TASK_TOOLS = new Set(['Task', 'Agent', 'task', 'agent']);
const FILE_WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'edit', 'write', 'multiedit']);

function isTaskTool(toolName) { return TASK_TOOLS.has(String(toolName || '')); }
function isFileWriteTool(toolName) { return FILE_WRITE_TOOLS.has(String(toolName || '')); }

function extractSubagentType(toolInput) {
  if (!toolInput) return '';
  return String(toolInput.subagent_type || toolInput.subagentType || '');
}

function extractResponseText(toolResponse) {
  if (toolResponse === null || toolResponse === undefined) return '';
  if (typeof toolResponse === 'string') return toolResponse;
  try { return JSON.stringify(toolResponse); } catch { return ''; }
}

function safeRead(path) {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf-8');
  } catch { return null; }
}

function ensureDir(path) {
  try { if (!existsSync(path)) mkdirSync(path, { recursive: true }); } catch { /* noop */ }
}

// ============================================================================
// S0 — Seed contract_snippet hallucination check
// ============================================================================

const SEED_PATH_RE = /\.mpl\/seeds\/[^/]+\.ya?ml$/;

export function extractContractSnippet(yamlText) {
  const result = { inbound: [], outbound: [], contractRef: null };
  if (!yamlText) return result;

  const snippetMatch = yamlText.match(/contract_snippet\s*:\s*\n([\s\S]*?)(?=\n\s{0,6}\w+:|$)/);
  if (!snippetMatch) return result;
  const snippetBlock = snippetMatch[1];

  if (/contract_snippet\s*:\s*null/i.test(yamlText)) return result;

  const refMatch = snippetBlock.match(/contract_ref\s*:\s*["']?([^\s"'\n]+)["']?/);
  if (refMatch) result.contractRef = refMatch[1] === 'null' ? null : refMatch[1];

  const inboundMatch = snippetBlock.match(/inbound\s*:\s*\n((?:\s+\w[^\n]*\n)*)/);
  if (inboundMatch && !/inbound\s*:\s*null/i.test(snippetBlock)) {
    const keyPattern = /^\s+(\w[\w_]*)\s*:/gm;
    let m;
    while ((m = keyPattern.exec(inboundMatch[1])) !== null) {
      if (m[1] !== 'outbound' && m[1] !== 'contract_ref') result.inbound.push(m[1]);
    }
  }

  const outboundMatch = snippetBlock.match(/outbound\s*:\s*\n((?:\s+\w[^\n]*\n)*)/);
  if (outboundMatch && !/outbound\s*:\s*null/i.test(snippetBlock)) {
    const keyPattern = /^\s+(\w[\w_]*)\s*:/gm;
    let m;
    while ((m = keyPattern.exec(outboundMatch[1])) !== null) {
      if (m[1] !== 'contract_ref') result.outbound.push(m[1]);
    }
  }

  return result;
}

export function loadContract(cwd, contractPath) {
  if (!contractPath) return null;
  try {
    const fullPath = contractPath.startsWith('/') ? contractPath : resolve(cwd, contractPath);
    const raw = readFileSync(fullPath, 'utf-8');
    const contract = JSON.parse(raw);
    return {
      params: contract.params ? Object.keys(contract.params) : [],
      returns: contract.returns ? Object.keys(contract.returns) : [],
    };
  } catch { return null; }
}

export function findHallucinatedKeys(snippetKeys, contractKeys) {
  if (!snippetKeys || snippetKeys.length === 0) return [];
  if (!contractKeys) return [...snippetKeys];
  const set = new Set(contractKeys);
  return snippetKeys.filter(k => !set.has(k));
}

function collectSeedTextFromToolInput(toolInput) {
  const texts = [];
  if (!toolInput) return texts;
  const pushIf = (fp, t) => {
    if (typeof fp === 'string' && SEED_PATH_RE.test(fp) && typeof t === 'string') texts.push(t);
  };
  pushIf(toolInput.file_path || toolInput.filePath, toolInput.content || toolInput.new_string || toolInput.newString);
  if (Array.isArray(toolInput.edits)) {
    for (const e of toolInput.edits) pushIf(e?.file_path || e?.filePath, e?.content || e?.new_string || e?.newString);
  }
  return texts;
}

/**
 * S0 — Seed Fact-Check (SNT-S0). PostToolUse handler.
 * Substring-guarded on `contract_snippet:` — cheap by construction.
 */
export function handleSentinelS0(ctx) {
  const { cwd, toolName, toolInput, toolResponse, config } = ctx;
  if (!isTaskTool(toolName) && !isFileWriteTool(toolName)) return noop();

  // Subagent filter (file-write bypasses; its SEED_PATH_RE gate is sufficient).
  if (isTaskTool(toolName)) {
    const filter = resolveSentinelFilter(config, 's0');
    if (!subagentPassesFilter(extractSubagentType(toolInput), filter)) return noop({ ruleId: 'sentinel.s0.filtered' });
  }

  let responseText = extractResponseText(toolResponse);
  if (isFileWriteTool(toolName)) {
    const seedTexts = collectSeedTextFromToolInput(toolInput);
    if (seedTexts.length === 0) return noop();
    responseText = seedTexts.join('\n') || responseText;
  } else {
    if (!/contract_snippet\s*:/.test(responseText)) return noop();
  }

  const snippet = extractContractSnippet(responseText);
  if (!snippet.contractRef && snippet.inbound.length === 0 && snippet.outbound.length === 0) return noop();
  if (!snippet.contractRef) return noop();

  const contract = loadContract(cwd, snippet.contractRef);
  if (!contract) {
    const msg = `SEED HALLUCINATION: contract_ref "${snippet.contractRef}" not found or invalid. Cannot verify contract_snippet keys.`;
    return signal({
      ruleId: 'sentinel.s0',
      additionalContext: `<system-reminder>\n${msg}\n</system-reminder>`,
    });
  }

  const inboundMissing = findHallucinatedKeys(snippet.inbound, contract.params);
  const outboundMissing = findHallucinatedKeys(snippet.outbound, contract.returns);
  if (inboundMissing.length === 0 && outboundMissing.length === 0) return noop();

  const parts = [];
  if (inboundMissing.length > 0) parts.push(`inbound keys {${inboundMissing.join(', ')}} not in contract ${snippet.contractRef} .params`);
  if (outboundMissing.length > 0) parts.push(`outbound keys {${outboundMissing.join(', ')}} not in contract ${snippet.contractRef} .returns`);
  const warning = `SEED HALLUCINATION: ${parts.join('; ')}`;
  return signal({
    ruleId: 'sentinel.s0',
    additionalContext: `<system-reminder>\n${warning}\n</system-reminder>`,
  });
}

// ============================================================================
// S1 — Export Manifest Symbol Validator
// ============================================================================

const S1_SYMBOL_PATTERNS = [
  (name) => new RegExp(`\\bexport\\s+(async\\s+)?function\\s+${escapeRegex(name)}\\b`),
  (name) => new RegExp(`\\bexport\\s+class\\s+${escapeRegex(name)}\\b`),
  (name) => new RegExp(`\\bexport\\s+(const|let|var)\\s+${escapeRegex(name)}\\b`),
  (name) => name === 'default' ? new RegExp(`\\bexport\\s+default\\b`) : null,
  (name) => new RegExp(`\\bexport\\s*\\{[^}]*\\b${escapeRegex(name)}\\b[^}]*\\}`),
  (name) => new RegExp(`\\bdef\\s+${escapeRegex(name)}\\b`),
  (name) => new RegExp(`\\bclass\\s+${escapeRegex(name)}\\b`),
  (name) => new RegExp(`\\bpub\\s+fn\\s+${escapeRegex(name)}\\b`),
  (name) => new RegExp(`\\bpub\\s+(struct|enum|type)\\s+${escapeRegex(name)}\\b`),
];

function escapeRegex(str) { return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function symbolExistsInContent(symbolName, content) {
  for (const fn of S1_SYMBOL_PATTERNS) {
    const re = fn(symbolName);
    if (re && re.test(content)) return true;
  }
  return false;
}

export function findManifestPaths(cwd) {
  const phasesDir = join(cwd, '.mpl', 'mpl', 'phases');
  if (!existsSync(phasesDir)) return [];
  const out = [];
  try {
    for (const entry of readdirSync(phasesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const p = join(phasesDir, entry.name, 'export-manifest.json');
      if (existsSync(p)) out.push(p);
    }
  } catch { /* noop */ }
  return out;
}

export function validateManifest(manifestPath, cwd) {
  const errors = [];
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')); }
  catch (e) { return { valid: false, errors: [`Failed to parse ${manifestPath}: ${e.message}`] }; }
  const exports = manifest.exports;
  if (!Array.isArray(exports)) return { valid: true, errors: [] };
  for (const entry of exports) {
    const filePath = entry.file || entry.path;
    if (!filePath) { errors.push(`Export entry missing "file" field in ${manifestPath}`); continue; }
    const resolved = resolve(cwd, filePath);
    if (!existsSync(resolved)) { errors.push(`File not found: ${filePath} (resolved: ${resolved})`); continue; }
    const symbols = entry.symbols;
    if (!Array.isArray(symbols) || symbols.length === 0) continue;
    let content;
    try { content = readFileSync(resolved, 'utf-8'); }
    catch { errors.push(`Cannot read file: ${filePath}`); continue; }
    for (const symbol of symbols) {
      const name = typeof symbol === 'string' ? symbol : symbol.name || symbol.symbol;
      if (!name) continue;
      if (!symbolExistsInContent(name, content)) errors.push(`Symbol "${name}" not found in ${filePath}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * S1 — Export Manifest Validator. PostToolUse handler.
 * CLOSES EVAL FINDING: subagent_type_filter prevents the FS scan from firing
 * on every Task|Agent (debate, validate-seed, etc.) — default = phase-runner only.
 */
export function handleSentinelS1(ctx) {
  const { cwd, toolName, toolInput, config } = ctx;
  if (!isTaskTool(toolName)) return noop();

  const filter = resolveSentinelFilter(config, 's1');
  if (!subagentPassesFilter(extractSubagentType(toolInput), filter)) return noop({ ruleId: 'sentinel.s1.filtered' });

  const manifestPaths = findManifestPaths(cwd);
  if (manifestPaths.length === 0) return noop();

  const allErrors = [];
  for (const mp of manifestPaths) {
    const { errors } = validateManifest(mp, cwd);
    allErrors.push(...errors);
  }
  if (allErrors.length === 0) return noop();

  const message =
    `[MPL SENTINEL S1] Export manifest validation failed.\n\n` +
    `The following symbols/files declared in export-manifest.json could not be verified:\n` +
    allErrors.map(e => `  - ${e}`).join('\n') +
    `\n\nACTION REQUIRED: Phase Runner must fix missing exports before Test Agent runs.\n` +
    `Either create the missing symbols or update export-manifest.json to match actual exports.`;

  return signal({ ruleId: 'sentinel.s1', additionalContext: message });
}

// ============================================================================
// S3 — Test Import Path Validator
// ============================================================================

const S3_RESOLVE_EXTENSIONS = ['.ts', '.js', '.tsx', '.jsx', '.mjs', '.cjs'];
const S3_TEST_FILE_PATTERNS = [
  /\.test\.[jt]sx?$/, /\.spec\.[jt]sx?$/,
  /test_.*\.py$/, /.*_test\.py$/,
  /.*_test\.go$/, /.*_test\.rs$/,
  /__tests__\//,
];
const S3_IMPORT_PATTERNS = [
  /\bimport\s+(?:(?:[\w{},*\s]+)\s+from\s+)?['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bfrom\s+(\.[\w.]*)\s+import\b/g,
];

export function isTestFile(fileName) {
  return S3_TEST_FILE_PATTERNS.some(p => p.test(fileName));
}

export function extractImportPaths(content) {
  const paths = new Set();
  for (const pattern of S3_IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(content)) !== null) {
      if (m[1].startsWith('.')) paths.add(m[1]);
    }
  }
  return [...paths];
}

function s3IsFile(p) { try { return statSync(p).isFile(); } catch { return false; } }
function s3IsDirectory(p) { try { return statSync(p).isDirectory(); } catch { return false; } }

export function resolveImportPath(importPath, fromDir) {
  const basePath = resolve(fromDir, importPath);
  if (existsSync(basePath) && s3IsFile(basePath)) return basePath;
  for (const ext of S3_RESOLVE_EXTENSIONS) {
    const w = basePath + ext;
    if (existsSync(w) && s3IsFile(w)) return w;
  }
  if (existsSync(basePath) && s3IsDirectory(basePath)) {
    for (const ext of S3_RESOLVE_EXTENSIONS) {
      const ip = join(basePath, `index${ext}`);
      if (existsSync(ip)) return ip;
    }
  }
  return null;
}

function s3CollectTestFiles(dir, results, depth = 0) {
  if (depth > 3) return;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fp = join(dir, entry.name);
      if (entry.isFile() && isTestFile(entry.name)) results.push(fp);
      else if (entry.isDirectory() && depth < 3) s3CollectTestFiles(fp, results, depth + 1);
    }
  } catch { /* noop */ }
}

export function findTestFiles(cwd) {
  const phasesDir = join(cwd, '.mpl', 'mpl', 'phases');
  if (!existsSync(phasesDir)) return [];
  const out = [];
  try {
    for (const entry of readdirSync(phasesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      s3CollectTestFiles(join(phasesDir, entry.name), out);
    }
  } catch { /* noop */ }
  return out;
}

export function validateTestImports(testFilePath) {
  const invalid = [];
  let content;
  try { content = readFileSync(testFilePath, 'utf-8'); }
  catch { return { file: testFilePath, invalid: [{ importPath: '<unreadable>', resolvedAttempt: testFilePath }] }; }
  const fromDir = dirname(testFilePath);
  for (const importPath of extractImportPaths(content)) {
    const resolved = resolveImportPath(importPath, fromDir);
    if (!resolved) {
      invalid.push({ importPath, resolvedAttempt: resolve(fromDir, importPath) });
    }
  }
  return { file: testFilePath, invalid };
}

/**
 * S3 — Test Import Path Validator. PostToolUse handler.
 * CLOSES EVAL FINDING (biggest perf cost): subagent_type_filter prevents
 * recursive readdir+statSync from running on every Task|Agent.
 * Default = mpl-test-agent only.
 */
export function handleSentinelS3(ctx) {
  const { cwd, toolName, toolInput, config } = ctx;
  if (!isTaskTool(toolName)) return noop();

  const filter = resolveSentinelFilter(config, 's3');
  if (!subagentPassesFilter(extractSubagentType(toolInput), filter)) return noop({ ruleId: 'sentinel.s3.filtered' });

  const testFiles = findTestFiles(cwd);
  if (testFiles.length === 0) return noop();

  const allInvalid = [];
  for (const f of testFiles) {
    const { file, invalid } = validateTestImports(f);
    if (invalid.length > 0) allInvalid.push({ file, invalid });
  }
  if (allInvalid.length === 0) return noop();

  const lines = [];
  for (const { file, invalid } of allInvalid) {
    lines.push(`  ${file}:`);
    for (const { importPath, resolvedAttempt } of invalid) {
      lines.push(`    - import "${importPath}" -> not found (tried: ${resolvedAttempt})`);
    }
  }
  const message =
    `[MPL SENTINEL S3] Test import path validation failed.\n\n` +
    `The following test file imports could not be resolved to existing files:\n` +
    lines.join('\n') +
    `\n\nACTION REQUIRED: Fix broken import paths in test files before running Gate checks.\n` +
    `Verify that the imported modules exist and paths are correct relative to the test file location.`;

  return signal({ ruleId: 'sentinel.s3', additionalContext: message });
}

// ============================================================================
// PP-File — Pivot Point file-touch advisor
// ============================================================================

let _ppCache = null;
let _ppCacheMtime = null;

export function parsePivotPoints(content) {
  if (!content) return [];
  const results = [];
  const blocks = content.split(/(?=^##\s+PP-)/m);
  for (const block of blocks) {
    const header = block.match(/^##\s+(PP-\d+):\s*(.+)/m);
    if (!header) continue;
    const pp_id = header[1];
    const constraint = header[2].trim();
    const patterns = [];
    for (const m of block.matchAll(/`([^`]+\.[a-zA-Z]{1,10})`/g)) patterns.push(m[1]);
    for (const m of block.matchAll(/(?:src|lib|app|hooks|commands|agents|prompts)\/[\w./\-*]+/g)) {
      if (!patterns.includes(m[0])) patterns.push(m[0]);
    }
    if (patterns.length > 0) results.push({ pp_id, constraint, patterns });
  }
  return results;
}

export function matchFileToPP(filePath, ppEntries) {
  const matches = [];
  const normalized = String(filePath).replace(/\\/g, '/');
  for (const entry of ppEntries) {
    for (const pattern of entry.patterns) {
      const np = pattern.replace(/\\/g, '/');
      if (np.includes('*')) {
        const re = new RegExp('^' + np.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
        if (re.test(normalized) || normalized.endsWith(np.replace(/\*/g, ''))) { matches.push(entry); break; }
      } else {
        if (normalized.endsWith(np) || normalized.includes(np)) { matches.push(entry); break; }
      }
    }
  }
  return matches;
}

function loadPPWithCache(cwd) {
  const p = resolve(cwd, '.mpl/pivot-points.md');
  if (!existsSync(p)) return [];
  const st = statSync(p);
  if (_ppCache && _ppCacheMtime === st.mtimeMs) return _ppCache;
  _ppCache = parsePivotPoints(readFileSync(p, 'utf-8'));
  _ppCacheMtime = st.mtimeMs;
  return _ppCache;
}

function collectTargetPathsFromInput(toolInput) {
  const out = [];
  if (!toolInput) return out;
  const pushIf = (v) => { if (typeof v === 'string' && v.length > 0) out.push(v); };
  pushIf(toolInput.file_path); pushIf(toolInput.filePath);
  if (Array.isArray(toolInput.edits)) {
    for (const e of toolInput.edits) { pushIf(e?.file_path); pushIf(e?.filePath); }
  }
  return out;
}

export function handleSentinelPPFile(ctx) {
  const { cwd, toolName, toolInput } = ctx;
  if (!isFileWriteTool(toolName)) return noop();

  const filePaths = collectTargetPathsFromInput(toolInput);
  if (filePaths.length === 0) return noop();

  const ppEntries = loadPPWithCache(cwd);
  if (ppEntries.length === 0) return noop();

  const matches = [];
  const seen = new Set();
  for (const fp of filePaths) {
    for (const m of matchFileToPP(fp, ppEntries)) {
      const k = `${m.pp_id}:${m.constraint}`;
      if (!seen.has(k)) { seen.add(k); matches.push(m); }
    }
  }
  if (matches.length === 0) return noop();

  const notices = matches.map(m =>
    `⚠️ ${m.pp_id}: "${m.constraint}" — this file is PP-constrained. Verify your edit satisfies the Pivot Point before proceeding.`
  ).join('\n');
  return signal({
    ruleId: 'sentinel.pp_file',
    additionalContext: `[MPL Sentinel PP-File] The file you just modified is referenced by active Pivot Point(s):\n${notices}`,
  });
}

// Cache reset hook for tests.
export function _resetPpCache() { _ppCache = null; _ppCacheMtime = null; }

// ============================================================================
// Soft Signal Emit — HA-01 vague delegation telemetry
// ============================================================================

const HA01_PHRASES = [
  // English
  /\buse your judg(e)?ment\b/i,
  /\b(figure|work) it out\b/i,
  /\bdo whatever (you|seems) (think|right|best)\b/i,
  /\buse the prior result\b/i,
  /\brefer to (the )?(previous|prior) (result|output)\b/i,
  // Korean
  /이전 결과 참고/i,
  /알아서 (판단|결정|해)/i,
  /적당히 (해|판단)/i,
];

export function detectHa01(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  for (const re of HA01_PHRASES) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m) return { phrase: m[0], offset: m.index, pattern: re.source };
  }
  return null;
}

export function handleSoftSignalEmit(ctx) {
  const { toolName, toolInput, event } = ctx;
  // Only fires on PreToolUse:Task|Agent (same as legacy hook).
  if (event && event !== 'PreToolUse') return noop();
  if (!isTaskTool(toolName)) return noop();
  const prompt = (toolInput && (toolInput.prompt || toolInput.description)) || '';
  const ha01 = detectHa01(prompt);
  if (!ha01) return noop();
  const subagentType = extractSubagentType(toolInput);
  return signal({
    ruleId: 'HA-01',
    sink: {
      kind: 'jsonl',
      path: '.mpl/mpl/quality-signals.jsonl',
      record: {
        rule: 'HA-01',
        severity: 'warn',
        ts: new Date().toISOString(),
        agent: subagentType || String(toolName || ''),
        evidence: {
          matched_phrase: ha01.phrase,
          offset: ha01.offset,
          prompt_preview: String(prompt).slice(Math.max(0, ha01.offset - 40), ha01.offset + 80),
        },
      },
    },
  });
}

// ============================================================================
// Gate Recorder — bash gate evidence + test-agent dispatch + phase-runner sync
// ============================================================================
//
// The full recorder still owns state writes (anomaly install, phase-runner block
// installation/clear, e2e_results) — those are decision side effects, not
// observability. This handler returns a "compact intent" the wrapper executes;
// the wrapper drives writeState so the L1 module stays free of state-writer
// imports. Today the wrapper is `mpl-gate-recorder.mjs` (preserved as
// `.legacy.mjs`) — see ROADMAP for the full migration.

export function classifyGateCommand(command, { rejectMaskingShell = true } = {}) {
  const cmd = String(command || '');
  if (!cmd.trim()) return { gate: null, reason: 'empty' };
  if (rejectMaskingShell) {
    if (/\|\|\s*true\b/.test(cmd)) return { gate: null, reason: 'mask_or_true' };
    if (/;\s*true\b/.test(cmd)) return { gate: null, reason: 'mask_semi_true' };
    if (/\|\s*(?!\|)/.test(cmd)) return { gate: null, reason: 'mask_pipe' };
    if (/&\s*$/.test(cmd)) return { gate: null, reason: 'mask_background' };
  }
  if (/\b(lint|tsc|typecheck|type-check|build|prettier --check)\b/.test(cmd)) return { gate: 'hard1_baseline' };
  if (/\b(vitest|jest|mocha|pytest|cargo test|go test|npm test|pnpm test|yarn test)\b/.test(cmd)) return { gate: 'hard2_coverage' };
  if (/\b(playwright|cypress|e2e|contract|a11y)\b/.test(cmd)) return { gate: 'hard3_resilience' };
  return { gate: null, reason: 'unrecognized' };
}

export function handleGateRecorder(ctx) {
  const { toolName, toolInput, toolResponse } = ctx;
  const t = String(toolName || '');
  if (t !== 'Bash' && t !== 'bash' && !isTaskTool(toolName)) return noop();

  // Bash branch — gate classification + e2e match return as an intent.
  if (t === 'Bash' || t === 'bash') {
    const command = (toolInput && (toolInput.command || toolInput.cmd)) || '';
    const cls = classifyGateCommand(command);
    if (!cls.gate) return noop({ ruleId: 'recorder.bash.skipped' });
    const exitCode = toolResponse && typeof toolResponse === 'object'
      ? (toolResponse.exit_code ?? toolResponse.exitCode ?? toolResponse.returncode)
      : undefined;
    const stdout = toolResponse && typeof toolResponse === 'object'
      ? String(toolResponse.stdout ?? toolResponse.output ?? '')
      : String(toolResponse || '');
    return signal({
      ruleId: 'recorder.bash',
      stateMutations: {
        kind: 'gate_recorder.bash',
        gate: cls.gate,
        command: command.slice(0, 500),
        exit_code: typeof exitCode === 'number'
          ? exitCode
          : (/error|failed|✖|exit code 1/i.test(stdout) ? 1 : 0),
        stdout_tail: stdout.length > 500 ? stdout.slice(-500) : stdout,
        timestamp: new Date().toISOString(),
      },
    });
  }

  // Task|Agent branch — defer evidence/anomaly detection to the wrapper.
  const subagentType = extractSubagentType(toolInput);
  return signal({
    ruleId: 'recorder.task',
    stateMutations: {
      kind: 'gate_recorder.task',
      subagent_type: subagentType,
      prompt: String((toolInput && (toolInput.prompt || toolInput.description)) || ''),
      response: toolResponse,
    },
  });
}

// ============================================================================
// Discovery Scanner — chains/{id}/phases/{phase}/discovery-* filter
// ============================================================================

const DISCOVERY_RUNNER_SET = new Set(['mpl-phase-runner', 'mpl:mpl-phase-runner']);

export function shouldFilterDiscoveryCandidate(candidate, designIntent, chainSeed, decomposition) {
  const needle = candidate.path || candidate.file || candidate.contract || candidate.symbol;
  if (!needle) return false;
  if (designIntent && designIntent.includes(needle)) return true;
  if (chainSeed && chainSeed.includes(needle)) return true;
  if (decomposition && decomposition.includes(needle)) return true;
  if (candidate.type === 'rename' || candidate.type === 'variable_rename') return true;
  if (candidate.type === 'test_fixture' || candidate.type === 'test_data') return true;
  return false;
}

export function readDiscoveryCandidates(path) {
  const content = safeRead(path);
  if (!content) return [];
  const candidates = [];
  const lines = content.split('\n');
  let inList = false;
  let current = null;
  for (const line of lines) {
    if (/^candidates:\s*$/.test(line)) { inList = true; continue; }
    if (!inList) continue;
    const start = line.match(/^\s*-\s*id:\s*["']?([^"'\n]+)["']?/);
    if (start) {
      if (current) candidates.push(current);
      current = { id: start[1].trim(), raw: [line] };
      continue;
    }
    if (current && /^\s{4,}/.test(line)) {
      current.raw.push(line);
      const kv = line.match(/^\s+(\w+):\s*["']?([^"'\n]*)["']?/);
      if (kv) current[kv[1]] = kv[2].trim();
    } else if (current && !/^\s*$/.test(line) && !line.startsWith(' ')) {
      candidates.push(current); current = null; inList = false;
    }
  }
  if (current) candidates.push(current);
  return candidates;
}

export function handleDiscoveryScanner(ctx) {
  const { cwd, toolName, toolInput, state, config } = ctx;
  if (!isTaskTool(toolName)) return noop();
  if (!DISCOVERY_RUNNER_SET.has(extractSubagentType(toolInput))) return noop();

  const discoveryCfg = (config && config.discovery) || {};
  if (discoveryCfg.scanner_enabled === false) return noop();

  const phaseId = (state && (state.current_phase_name || state.current_phase)) || 'unknown';
  const chainAssignment = safeRead(join(cwd, '.mpl/mpl/chain-assignment.yaml'));
  if (!chainAssignment) return noop();

  const blocks = chainAssignment.split(/^\s*-\s+id:\s*/m).slice(1);
  let chainId = null;
  for (const block of blocks) {
    const idM = block.match(/^["']?([^"'\n]+)["']?/);
    const phM = block.match(/phases:\s*\[([^\]]+)\]/);
    if (!idM || !phM) continue;
    const phases = phM[1].split(',').map(s => s.trim().replace(/["']/g, ''));
    if (phases.includes(phaseId)) { chainId = idM[1].trim(); break; }
  }
  if (!chainId) return noop();

  const candidatesPath = join(cwd, '.mpl/mpl/chains', chainId, 'phases', phaseId, 'discovery-candidates.yaml');
  if (!existsSync(candidatesPath)) return noop();

  const candidates = readDiscoveryCandidates(candidatesPath);
  if (candidates.length === 0) return noop();

  const designIntent = safeRead(join(cwd, '.mpl/mpl/phase0/design-intent.yaml'));
  const chainSeed = safeRead(join(cwd, '.mpl/mpl/chains', chainId, 'chain-seed.yaml'));
  const decomposition = safeRead(join(cwd, '.mpl/mpl/decomposition.yaml'));

  const pending = [];
  const filtered = [];
  for (const c of candidates) {
    if (shouldFilterDiscoveryCandidate(c, designIntent, chainSeed, decomposition)) {
      filtered.push({ id: c.id, reason: 'mechanical_filter_matched', type: c.type || 'unknown' });
    } else {
      pending.push(c);
    }
  }

  const ts = new Date().toISOString();
  const pendingYaml = [
    `# Discovery Scanner output — candidates that passed mechanical filter`,
    `chain_id: "${chainId}"`,
    `phase_id: "${phaseId}"`,
    `scanned_at: "${ts}"`,
    `scanner_mode: "${discoveryCfg.agent_enabled ? 'agent_enabled' : 'measure_only'}"`,
    `pending_count: ${pending.length}`,
    `filtered_count: ${filtered.length}`,
    `candidates:`,
    ...pending.flatMap(c => c.raw || [`  - id: "${c.id}"`]),
  ].join('\n');
  const filteredYaml = [
    `# Discovery Scanner — candidates filtered out as noise`,
    `chain_id: "${chainId}"`,
    `phase_id: "${phaseId}"`,
    `scanned_at: "${ts}"`,
    `filtered:`,
    ...filtered.map(f => `  - id: "${f.id}"\n    reason: "${f.reason}"\n    type: "${f.type}"`),
  ].join('\n');

  try {
    writeFileSync(join(cwd, '.mpl/mpl/chains', chainId, 'phases', phaseId, 'discovery-pending.yaml'), pendingYaml);
    writeFileSync(join(cwd, '.mpl/mpl/chains', chainId, 'phases', phaseId, 'discovery-filtered.yaml'), filteredYaml);
  } catch { /* silent */ }

  return signal({
    ruleId: 'discovery.scanner',
    sink: { kind: 'yaml', chain_id: chainId, phase_id: phaseId, pending: pending.length, filtered: filtered.length },
  });
}

// ============================================================================
// Keyword Detector — UserPromptSubmit activator
// ============================================================================

const SLASH_NO_INIT = /^\s*\/mpl:mpl-(resume|cancel|status|doctor|setup|version-bump|pivot|gap-analysis)\b/i;

export function sanitizePromptForKeyword(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, '')
    .replace(/https?:\/\/[^\s)>\]]+/g, '')
    .replace(/(?<=^|[\s"'`(])(?:\/)?(?:[\w.-]+\/)+[\w.-]+/gm, '');
}

export function isTaskNotificationPrompt(prompt) {
  return /^<task-notification(?:\s|>)/i.test(String(prompt || '').trimStart());
}

export function extractKeywordFeatureName(prompt) {
  const cleaned = String(prompt || '').replace(/\bmpl\b/gi, '').trim();
  if (!cleaned) return 'unnamed';
  const words = cleaned.split(/\s+/)
    .filter(w => w.length > 2 && !/^(the|and|for|with|this|that|from|into)$/i.test(w))
    .slice(0, 4);
  return (words.join('-').toLowerCase().replace(/[^a-z0-9가-힣ぁ-ゔァ-ヴ一-鿿-]/g, '').replace(/^[-]+|[-]+$/g, '')) || 'task';
}

/**
 * Keyword Detector. UserPromptSubmit handler. Pure decision — wrapper drives
 * `initState`, intervention-count writeState, and lock-file checks.
 */
export function handleKeywordDetector(ctx) {
  const { event, raw, cwd, state } = ctx;
  if (event && event !== 'UserPromptSubmit') return noop();

  const prompt =
    (raw && (raw.prompt || raw.message?.content || (Array.isArray(raw.parts)
      ? raw.parts.filter(p => p.type === 'text').map(p => p.text).join(' ')
      : ''))) || '';
  if (!prompt) return noop();
  if (isTaskNotificationPrompt(prompt)) return noop();
  if (SLASH_NO_INIT.test(prompt)) return noop();

  const cleaned = sanitizePromptForKeyword(prompt).toLowerCase();
  if (!/\bmpl\b/i.test(cleaned)) return noop();

  const isResearchRun = /\bmpl[\s-]*(research|investigate|survey)\b/i.test(cleaned);
  const isMplActive = !!(state && state.pipeline_id && state.current_phase !== 'completed' && state.current_phase !== 'cancelled');

  if (isResearchRun) {
    if (isMplActive) {
      return signal({
        ruleId: 'keyword.research_blocked_pipeline',
        additionalContext: '[MPL] Pipeline research in progress. Use `/mpl:mpl-status` to check.',
      });
    }
    const lockPath = join(cwd || '', '.mpl', 'research', '.lock');
    if (cwd && existsSync(lockPath)) {
      return signal({
        ruleId: 'keyword.research_blocked_lock',
        additionalContext: '[MPL] Another standalone research is in progress. Wait for it to complete or delete .mpl/research/.lock to force.',
      });
    }
    const topic = prompt.replace(/\bmpl[\s-]*(research|investigate|survey)\b/gi, '').trim();
    return signal({
      ruleId: 'keyword.research',
      additionalContext:
        `[MAGIC KEYWORD: MPL-RESEARCH]\n\nMPL Standalone Research activated.\n\n` +
        `You MUST invoke the skill using the Skill tool:\n\nSkill: mpl-research\n\n` +
        `User request:\n${prompt}\n\nResearch topic: ${topic || 'as described in user request'}\n\n` +
        `IMPORTANT: Run the standalone research protocol. Results will be saved to .mpl/research/.`,
    });
  }

  if (isMplActive) {
    return signal({
      ruleId: 'keyword.already_active',
      additionalContext: '[MPL] Pipeline already active. Use current session or cancel first.',
    });
  }

  return signal({
    ruleId: 'keyword.activate',
    stateMutations: {
      kind: 'keyword.init',
      feature_name: extractKeywordFeatureName(prompt),
      run_mode: 'auto',
    },
    additionalContext:
      `[MAGIC KEYWORD: MPL]\n\nMPL Pipeline activated. State initialized at .mpl/state.json (run_mode: "auto").\n\n` +
      `You MUST invoke the skill using the Skill tool:\n\nSkill: mpl\n\nUser request:\n${prompt}\n\n` +
      `IMPORTANT: Load the MPL orchestration protocol via /mpl:mpl-run command, then begin Step 0 Pre-flight.`,
  });
}

// ============================================================================
// Top-level dispatch — keeps the wrappers tiny
// ============================================================================

const HANDLER_BY_NAME = {
  s0: handleSentinelS0,
  s1: handleSentinelS1,
  s3: handleSentinelS3,
  pp_file: handleSentinelPPFile,
  soft_signal_emit: handleSoftSignalEmit,
  gate_recorder: handleGateRecorder,
  discovery_scanner: handleDiscoveryScanner,
  keyword_detector: handleKeywordDetector,
};

export function handle(name, ctx) {
  const fn = HANDLER_BY_NAME[name];
  if (!fn) return noop({ ruleId: `signals.unknown.${name}` });
  return fn(ctx || {});
}

// ============================================================================
// emit(payload) — engine bridge (consumed by mpl-engine.mjs Step 8)
// ============================================================================
//
// Today the engine calls `signalsMod.emit({event, toolName, modules, decisions})`
// purely as a placeholder. Make it real (but inert by default): when
// `process.env.MPL_SIGNALS_LOG` is set, append a single JSON line per call
// to that path. Failures are swallowed; never throw, never block.

let _emitState = { count: 0, last: null };

/**
 * Emit a structured signal payload. Returns `{ok, sink}`.
 *
 * Shape contract used by mpl-engine.mjs Step 8:
 *   {
 *     event:    string,            // hook event name
 *     toolName: string|undefined,
 *     modules:  string[],           // dispatched module ids
 *     decisions: string[],          // action labels in order
 *     ...arbitrary additional fields ignored
 *   }
 *
 * The function is safe to call without awaiting (returns a resolved value)
 * and is intentionally synchronous-friendly so the engine fail-open path
 * stays simple.
 */
export function emit(payload) {
  _emitState.count += 1;
  const record = payload && typeof payload === 'object'
    ? { ts: new Date().toISOString(), ...payload }
    : { ts: new Date().toISOString(), payload };
  _emitState.last = record;

  const sinkPath = process.env.MPL_SIGNALS_LOG;
  if (sinkPath) {
    try {
      ensureDir(dirname(sinkPath));
      appendFileSync(sinkPath, JSON.stringify(record) + '\n');
      return { ok: true, sink: sinkPath };
    } catch {
      // fail-soft
    }
  }
  return { ok: true, sink: null };
}

/** Test-only: introspect the in-memory emit state. */
export function _emitStateSnapshot() {
  return { count: _emitState.count, last: _emitState.last };
}
export function _resetEmitState() { _emitState = { count: 0, last: null }; }

export default {
  handle,
  emit,
  handleSentinelS0, handleSentinelS1, handleSentinelS3,
  handleSentinelPPFile, handleSoftSignalEmit,
  handleGateRecorder, handleDiscoveryScanner, handleKeywordDetector,
  resolveSentinelFilter, subagentPassesFilter,
  SENTINEL_DEFAULT_FILTERS,
};
