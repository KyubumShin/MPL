import { existsSync, lstatSync, readdirSync } from 'fs';
import { extname, join, relative, sep } from 'path';

const KIB = 1024;
const MIB = KIB * 1024;
const GIB = MIB * 1024;
const MAX_SCAN_ERRORS = 25;

export const DEFAULT_TAURI_RUST_RESOURCE_THRESHOLDS = {
  targetWarnBytes: 8 * GIB,
  depsWarnBytes: 8 * GIB,
  staticLibWarnBytes: 512 * MIB,
  depsDominanceRatio: 0.9,
};

// Keep threshold config human-readable once config/env wiring is added.
export function parseByteSize(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.round(value);
  }
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d+(?:\.\d+)?)\s*(b|bytes?|kb|kib|mb|mib|gb|gib|tb|tib)?$/i);
  if (!m) return null;
  const amount = Number(m[1]);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const unit = (m[2] || 'b').toLowerCase();
  const mult = {
    b: 1,
    byte: 1,
    bytes: 1,
    kb: KIB,
    kib: KIB,
    mb: MIB,
    mib: MIB,
    gb: GIB,
    gib: GIB,
    tb: GIB * 1024,
    tib: GIB * 1024,
  }[unit];
  return Math.round(amount * mult);
}

export function formatBytes(bytes) {
  const n = typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : 0;
  if (n >= GIB) return `${(n / GIB).toFixed(1)} GiB`;
  if (n >= MIB) return `${(n / MIB).toFixed(1)} MiB`;
  if (n >= KIB) return `${(n / KIB).toFixed(1)} KiB`;
  return `${n} B`;
}

function posixRel(cwd, filePath) {
  return relative(cwd, filePath).split(sep).join('/');
}

function isDepsPath(filePath) {
  return filePath.split(sep).includes('deps');
}

function normalizeThresholds(thresholds = DEFAULT_TAURI_RUST_RESOURCE_THRESHOLDS) {
  const overrides = thresholds && typeof thresholds === 'object' ? thresholds : {};
  const t = { ...DEFAULT_TAURI_RUST_RESOURCE_THRESHOLDS, ...overrides };
  const ratio = Number(t.depsDominanceRatio);
  return {
    targetWarnBytes: parseByteSize(t.targetWarnBytes) ?? DEFAULT_TAURI_RUST_RESOURCE_THRESHOLDS.targetWarnBytes,
    depsWarnBytes: parseByteSize(t.depsWarnBytes) ?? DEFAULT_TAURI_RUST_RESOURCE_THRESHOLDS.depsWarnBytes,
    staticLibWarnBytes: parseByteSize(t.staticLibWarnBytes) ?? DEFAULT_TAURI_RUST_RESOURCE_THRESHOLDS.staticLibWarnBytes,
    depsDominanceRatio: Number.isFinite(ratio) && ratio > 0 && ratio <= 1
      ? ratio
      : DEFAULT_TAURI_RUST_RESOURCE_THRESHOLDS.depsDominanceRatio,
  };
}

function scanError(cwd, filePath, err) {
  return {
    path: posixRel(cwd, filePath),
    code: err?.code || err?.name || 'SCAN_ERROR',
    message: err?.message || String(err),
  };
}

function scanTargetTree(targetDir, cwd, fsImpl = { existsSync, lstatSync, readdirSync }) {
  const result = {
    targetBytes: 0,
    depsBytes: 0,
    largestStaticLib: null,
    scanErrorCount: 0,
    scanErrors: [],
  };

  function recordScanError(filePath, err) {
    result.scanErrorCount += 1;
    if (result.scanErrors.length < MAX_SCAN_ERRORS) {
      result.scanErrors.push(scanError(cwd, filePath, err));
    }
  }

  if (!fsImpl.existsSync(targetDir)) return result;

  const stack = [targetDir];
  while (stack.length > 0) {
    const filePath = stack.pop();
    let st;
    try {
      st = fsImpl.lstatSync(filePath);
    } catch (err) {
      recordScanError(filePath, err);
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      let entries = [];
      try {
        entries = fsImpl.readdirSync(filePath);
      } catch (err) {
        recordScanError(filePath, err);
        continue;
      }
      for (const entry of entries) stack.push(join(filePath, entry));
      continue;
    }
    if (!st.isFile()) continue;

    result.targetBytes += st.size;
    if (isDepsPath(filePath)) result.depsBytes += st.size;
    if (extname(filePath) === '.a') {
      const candidate = {
        path: posixRel(cwd, filePath),
        bytes: st.size,
        human: formatBytes(st.size),
      };
      if (!result.largestStaticLib || candidate.bytes > result.largestStaticLib.bytes) {
        result.largestStaticLib = candidate;
      }
    }
  }

  return result;
}

function warning({ id, measurement, path, bytes, thresholdBytes, recommendation }) {
  return {
    id,
    severity: 'warn',
    measurement,
    path,
    bytes,
    human: formatBytes(bytes),
    threshold_bytes: thresholdBytes,
    threshold_human: formatBytes(thresholdBytes),
    recommendation,
  };
}

export function detectTauriRustResourceRisk(cwd, thresholds = DEFAULT_TAURI_RUST_RESOURCE_THRESHOLDS, options = {}) {
  const fsImpl = options.fs || { existsSync, lstatSync, readdirSync };
  const effectiveThresholds = normalizeThresholds(thresholds);
  const root = cwd || process.cwd();
  const tauriRoot = join(root, 'src-tauri');
  const targetDir = join(tauriRoot, 'target');
  const isTauriRust = fsImpl.existsSync(join(tauriRoot, 'Cargo.toml')) || fsImpl.existsSync(targetDir);
  if (!isTauriRust) {
    return {
      kind: 'tauri_rust_resource_risk',
      status: 'not_applicable',
      measurements: [],
      warnings: [],
      scan_errors: [],
      scan_error_count: 0,
    };
  }

  const scan = scanTargetTree(targetDir, root, fsImpl);
  const measurements = [];
  const warnings = [];

  if (fsImpl.existsSync(targetDir)) {
    measurements.push({
      id: 'src_tauri_target',
      path: posixRel(root, targetDir),
      bytes: scan.targetBytes,
      human: formatBytes(scan.targetBytes),
    });
    measurements.push({
      id: 'src_tauri_target_deps',
      path: 'src-tauri/target/**/deps',
      bytes: scan.depsBytes,
      human: formatBytes(scan.depsBytes),
    });
  }
  if (scan.largestStaticLib) {
    measurements.push({
      id: 'largest_static_lib',
      ...scan.largestStaticLib,
    });
  }

  const depsDominatesTarget = scan.targetBytes > 0
    && scan.depsBytes >= effectiveThresholds.depsWarnBytes
    && scan.depsBytes / scan.targetBytes >= effectiveThresholds.depsDominanceRatio;

  if (scan.scanErrorCount > 0) {
    warnings.push({
      id: 'tauri_scan_partial_warn',
      severity: 'warn',
      measurement: 'scan_errors',
      path: 'src-tauri/target',
      count: scan.scanErrorCount,
      shown: scan.scanErrors.length,
      recommendation: 'Inspect unreadable target paths and rerun the doctor audit so resource-risk measurements are not treated as clean when the scan was partial.',
    });
  }
  if (scan.targetBytes >= effectiveThresholds.targetWarnBytes && !depsDominatesTarget) {
    warnings.push(warning({
      id: 'tauri_target_size_warn',
      measurement: 'src_tauri_target',
      path: 'src-tauri/target',
      bytes: scan.targetBytes,
      thresholdBytes: effectiveThresholds.targetWarnBytes,
      recommendation: 'Run cargo clean when safe, lower build/test concurrency, or split large Rust/Tauri work into smaller crates/phases.',
    }));
  }
  if (scan.depsBytes >= effectiveThresholds.depsWarnBytes) {
    warnings.push(warning({
      id: 'tauri_deps_size_warn',
      measurement: 'src_tauri_target_deps',
      path: 'src-tauri/target/**/deps',
      bytes: scan.depsBytes,
      thresholdBytes: effectiveThresholds.depsWarnBytes,
      recommendation: 'Reduce duplicate dependency builds, prefer workspace-level crate boundaries, and clean stale target deps before long verification loops.',
    }));
  }
  if (scan.largestStaticLib && scan.largestStaticLib.bytes >= effectiveThresholds.staticLibWarnBytes) {
    warnings.push(warning({
      id: 'tauri_static_lib_size_warn',
      measurement: 'largest_static_lib',
      path: scan.largestStaticLib.path,
      bytes: scan.largestStaticLib.bytes,
      thresholdBytes: effectiveThresholds.staticLibWarnBytes,
      recommendation: 'Consider multi-crate decomposition or smaller Rust module boundaries before continuing long Tauri verification runs.',
    }));
  }

  return {
    kind: 'tauri_rust_resource_risk',
    status: warnings.length > 0 ? 'warn' : 'pass',
    measurements,
    warnings,
    scan_errors: scan.scanErrors,
    scan_error_count: scan.scanErrorCount,
  };
}
