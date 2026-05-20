import { existsSync, lstatSync, readdirSync } from 'fs';
import { extname, join, relative, sep } from 'path';

const KIB = 1024;
const MIB = KIB * 1024;
const GIB = MIB * 1024;

export const DEFAULT_TAURI_RUST_RESOURCE_THRESHOLDS = {
  targetWarnBytes: 8 * GIB,
  depsWarnBytes: 8 * GIB,
  staticLibWarnBytes: 512 * MIB,
};

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

function scanTargetTree(targetDir, cwd) {
  const result = {
    targetBytes: 0,
    depsBytes: 0,
    largestStaticLib: null,
  };

  function walk(filePath) {
    let st;
    try {
      st = lstatSync(filePath);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      let entries = [];
      try {
        entries = readdirSync(filePath);
      } catch {
        return;
      }
      for (const entry of entries) walk(join(filePath, entry));
      return;
    }
    if (!st.isFile()) return;

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

  if (existsSync(targetDir)) walk(targetDir);
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

export function detectTauriRustResourceRisk(cwd, thresholds = DEFAULT_TAURI_RUST_RESOURCE_THRESHOLDS) {
  const root = cwd || process.cwd();
  const tauriRoot = join(root, 'src-tauri');
  const targetDir = join(tauriRoot, 'target');
  const isTauriRust = existsSync(join(tauriRoot, 'Cargo.toml')) || existsSync(targetDir);
  if (!isTauriRust) {
    return {
      kind: 'tauri_rust_resource_risk',
      status: 'not_applicable',
      measurements: [],
      warnings: [],
    };
  }

  const scan = scanTargetTree(targetDir, root);
  const measurements = [];
  const warnings = [];

  if (existsSync(targetDir)) {
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

  if (scan.targetBytes >= thresholds.targetWarnBytes) {
    warnings.push(warning({
      id: 'tauri_target_size_warn',
      measurement: 'src_tauri_target',
      path: 'src-tauri/target',
      bytes: scan.targetBytes,
      thresholdBytes: thresholds.targetWarnBytes,
      recommendation: 'Run cargo clean when safe, lower build/test concurrency, or split large Rust/Tauri work into smaller crates/phases.',
    }));
  }
  if (scan.depsBytes >= thresholds.depsWarnBytes) {
    warnings.push(warning({
      id: 'tauri_deps_size_warn',
      measurement: 'src_tauri_target_deps',
      path: 'src-tauri/target/**/deps',
      bytes: scan.depsBytes,
      thresholdBytes: thresholds.depsWarnBytes,
      recommendation: 'Reduce duplicate dependency builds, prefer workspace-level crate boundaries, and clean stale target deps before long verification loops.',
    }));
  }
  if (scan.largestStaticLib && scan.largestStaticLib.bytes >= thresholds.staticLibWarnBytes) {
    warnings.push(warning({
      id: 'tauri_static_lib_size_warn',
      measurement: 'largest_static_lib',
      path: scan.largestStaticLib.path,
      bytes: scan.largestStaticLib.bytes,
      thresholdBytes: thresholds.staticLibWarnBytes,
      recommendation: 'Consider multi-crate decomposition or smaller Rust module boundaries before continuing long Tauri verification runs.',
    }));
  }

  return {
    kind: 'tauri_rust_resource_risk',
    status: warnings.length > 0 ? 'warn' : 'pass',
    measurements,
    warnings,
  };
}
