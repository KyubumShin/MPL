#!/usr/bin/env node
/**
 * MPL Context Rotation - Terminal Backends (F-38)
 * Abstracts /clear command delivery across terminal emulators.
 */
import { execSync } from 'child_process';

/**
 * Detect available terminal backend.
 * Priority: explicit config > env detection
 * @returns {'kitty'|'tmux'|'osascript'|null}
 */
export function detectBackend() {
  // Check TMUX env first (running inside tmux)
  if (process.env.TMUX) return 'tmux';

  // Check TERM_PROGRAM for terminal emulator
  const termProgram = process.env.TERM_PROGRAM || '';
  if (termProgram.toLowerCase().includes('kitty')) return 'kitty';

  // macOS fallback
  if (process.platform === 'darwin') return 'osascript';

  return null;
}

/**
 * Send /clear to the Claude Code session via the configured backend.
 * @param {string} backend - 'kitty' | 'tmux' | 'osascript'
 * @param {object} [opts] - backend-specific options
 * @param {string} [opts.tmux_pane] - tmux pane target (default: current)
 * @param {string} [opts.kitty_match] - kitty window match (default: recent)
 * @returns {{ success: boolean, error?: string }}
 */
export function sendClear(backend, opts = {}) {
  try {
    switch (backend) {
      case 'kitty': {
        // Kitty remote control: send "/clear\r" to the window
        // Requires: allow_remote_control yes in kitty.conf
        const match = opts.kitty_match || '';
        const matchArg = match ? `--match "${match}"` : '';
        execSync(`kitten @ send-text ${matchArg} "/clear\\r"`, {
          timeout: 5000,
          stdio: 'pipe',
        });
        return { success: true };
      }

      case 'tmux': {
        // tmux: send keys to pane
        const pane = opts.tmux_pane || '';
        const targetArg = pane ? `-t "${pane}"` : '';
        execSync(`tmux send-keys ${targetArg} "/clear" Enter`, {
          timeout: 5000,
          stdio: 'pipe',
        });
        return { success: true };
      }

      case 'osascript': {
        // macOS: send keystroke to frontmost terminal app
        // This types "/clear" then presses Enter
        const script = `
          tell application "System Events"
            keystroke "/clear"
            keystroke return
          end tell
        `;
        execSync(`osascript -e '${script}'`, {
          timeout: 5000,
          stdio: 'pipe',
        });
        return { success: true };
      }

      default:
        return { success: false, error: `Unknown backend: ${backend}` };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Test if the configured backend is functional.
 * @param {string} backend
 * @returns {{ available: boolean, error?: string }}
 */
export function testBackend(backend) {
  try {
    switch (backend) {
      case 'kitty': {
        execSync('kitten @ ls', { timeout: 3000, stdio: 'pipe' });
        return { available: true };
      }
      case 'tmux': {
        execSync('tmux display-message -p "#S"', { timeout: 3000, stdio: 'pipe' });
        return { available: true };
      }
      case 'osascript': {
        execSync('osascript -e "return 1"', { timeout: 3000, stdio: 'pipe' });
        return { available: true };
      }
      default:
        return { available: false, error: `Unknown backend: ${backend}` };
    }
  } catch (err) {
    return { available: false, error: err.message };
  }
}
