#!/usr/bin/env node
/**
 * MPL Context Rotator (F-38)
 * Background process that watches for session-handoff signals
 * and sends /clear via the configured terminal backend.
 *
 * Launched by orchestrator at pipeline start:
 *   nohup node hooks/lib/mpl-rotator.mjs <project_dir> &
 *
 * Lifecycle:
 *   1. Read .mpl/config.json for backend config
 *   2. Poll .mpl/signals/session-handoff.json every N seconds
 *   3. On signal: wait cooldown → send /clear → clean up signal
 *   4. Exit when pipeline completes or after max rotations
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// Use dynamic import for sibling module
const backendsPath = new URL('./rotation-backends.mjs', import.meta.url).href;
const { sendClear, detectBackend, testBackend } = await import(backendsPath);

const PROJECT_DIR = process.argv[2] || process.cwd();
const SIGNAL_FILE = join(PROJECT_DIR, '.mpl', 'signals', 'session-handoff.json');
const STATE_FILE = join(PROJECT_DIR, '.mpl', 'state.json');
const CONFIG_FILE = join(PROJECT_DIR, '.mpl', 'config.json');
const PID_FILE = join(PROJECT_DIR, '.mpl', 'signals', 'rotator.pid');
const LOG_FILE = join(PROJECT_DIR, '.mpl', 'signals', 'rotator.log');

const POLL_INTERVAL_MS = 3000;  // 3 seconds
const COOLDOWN_MS = 5000;       // 5s cooldown before sending /clear
const MAX_ROTATIONS = 10;       // safety limit

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  process.stderr.write(line);
  try {
    const logDir = join(PROJECT_DIR, '.mpl', 'signals');
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    writeFileSync(LOG_FILE, line, { flag: 'a' });
  } catch { /* ignore log failures */ }
}

function readConfig() {
  try {
    if (!existsSync(CONFIG_FILE)) return {};
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
  } catch { return {}; }
}

function readState() {
  try {
    if (!existsSync(STATE_FILE)) return null;
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch { return null; }
}

function isPipelineActive() {
  const state = readState();
  if (!state) return false;
  if (!state.current_phase) return false;
  if (state.current_phase === 'completed') return false;
  if (state.current_phase === 'cancelled') return false;
  return true;
}

function writePidFile() {
  const dir = join(PROJECT_DIR, '.mpl', 'signals');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(PID_FILE, String(process.pid));
}

function cleanupPidFile() {
  try { if (existsSync(PID_FILE)) unlinkSync(PID_FILE); } catch { /* ignore */ }
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const config = readConfig();
  const rotationConfig = config.context_rotation || {};

  // Determine backend
  let backend = rotationConfig.backend || detectBackend();
  if (!backend) {
    log('ERROR: No terminal backend detected. Set context_rotation.backend in .mpl/config.json');
    process.exit(1);
  }

  // Test backend
  const test = testBackend(backend);
  if (!test.available) {
    log(`ERROR: Backend "${backend}" not available: ${test.error}`);
    process.exit(1);
  }

  log(`Rotator started. Backend: ${backend}, PID: ${process.pid}`);
  log(`Watching: ${SIGNAL_FILE}`);

  writePidFile();
  process.on('exit', cleanupPidFile);
  process.on('SIGTERM', () => { cleanupPidFile(); process.exit(0); });
  process.on('SIGINT', () => { cleanupPidFile(); process.exit(0); });

  let rotationCount = 0;

  while (true) {
    // Check pipeline still active
    if (!isPipelineActive()) {
      log('Pipeline no longer active. Exiting.');
      break;
    }

    // Check rotation limit
    if (rotationCount >= MAX_ROTATIONS) {
      log(`Max rotations reached (${MAX_ROTATIONS}). Exiting.`);
      break;
    }

    // Check for handoff signal
    if (existsSync(SIGNAL_FILE)) {
      log('Handoff signal detected!');

      // Read signal for logging
      try {
        const signal = JSON.parse(readFileSync(SIGNAL_FILE, 'utf-8'));
        log(`Pipeline: ${signal.pipeline_id}, Resume from: ${signal.resume_from_phase}`);
      } catch { /* ignore parse errors */ }

      // Cooldown - let the model finish writing state
      log(`Cooldown ${COOLDOWN_MS}ms...`);
      await sleep(COOLDOWN_MS);

      // Send /clear
      log(`Sending /clear via ${backend}...`);
      const result = sendClear(backend, rotationConfig.backend_opts || {});

      if (result.success) {
        log('/clear sent successfully. Waiting for session restart...');
        rotationCount++;

        // Don't remove signal file - SessionStart hook needs it for resume detection
        // The SessionStart hook will clean it up after reading
      } else {
        log(`ERROR sending /clear: ${result.error}`);
        // Remove signal to prevent infinite retry
        try { unlinkSync(SIGNAL_FILE); } catch { /* ignore */ }
      }

      // Wait for session to restart before polling again
      await sleep(10000);  // 10s for session restart
    }

    await sleep(POLL_INTERVAL_MS);
  }

  cleanupPidFile();
  log('Rotator exiting.');
}

main().catch(err => {
  log(`Fatal error: ${err.message}`);
  cleanupPidFile();
  process.exit(1);
});
