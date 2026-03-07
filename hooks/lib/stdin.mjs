/**
 * Shared stdin utilities for MPL hooks
 * Local copy of OMC stdin helper for project portability.
 * See: ~/.claude/hooks/lib/stdin.mjs for the original
 */

/**
 * Read all stdin with timeout to prevent indefinite hang.
 * @param {number} timeoutMs - Maximum time to wait for stdin (default: 5000ms)
 * @returns {Promise<string>} - The stdin content, or empty string on error/timeout
 */
export async function readStdin(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        process.stdin.removeAllListeners();
        process.stdin.destroy();
        resolve(Buffer.concat(chunks).toString('utf-8'));
      }
    }, timeoutMs);

    process.stdin.on('data', (chunk) => {
      chunks.push(chunk);
    });

    process.stdin.on('end', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve(Buffer.concat(chunks).toString('utf-8'));
      }
    });

    process.stdin.on('error', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve('');
      }
    });

    if (process.stdin.readableEnded) {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve(Buffer.concat(chunks).toString('utf-8'));
      }
    }
  });
}
