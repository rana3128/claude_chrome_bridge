import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CONFIG_DIR = process.env.CCB_CONFIG_DIR || join(homedir(), '.claude-chrome-bridge');
export const TOKEN_PATH = join(CONFIG_DIR, 'token.json');

/**
 * Load the pairing token, generating one on first run. The token is the only
 * thing standing between this bridge and any other process on the machine, so
 * the file is 0600 inside a 0700 directory and never leaves the local disk.
 */
export function loadOrCreateToken({ rotate = false } = {}) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try { chmodSync(CONFIG_DIR, 0o700); } catch { /* best effort on non-POSIX */ }

  if (!rotate && existsSync(TOKEN_PATH)) {
    try {
      const parsed = JSON.parse(readFileSync(TOKEN_PATH, 'utf8'));
      if (typeof parsed.token === 'string' && parsed.token.length >= 32) return parsed;
    } catch {
      // Corrupt file: fall through and mint a fresh token rather than run unauthenticated.
    }
  }
  const record = {
    token: randomBytes(32).toString('base64url'),
    createdAt: new Date().toISOString(),
  };
  writeToken(record);
  return record;
}

export function writeToken(record) {
  writeFileSync(TOKEN_PATH, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  try { chmodSync(TOKEN_PATH, 0o600); } catch { /* best effort */ }
}

/** Constant-time token comparison; a length mismatch is still a mismatch. */
export function tokenMatches(expected, presented) {
  if (typeof expected !== 'string' || typeof presented !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  if (a.length !== b.length) {
    // Compare against itself so the work done is independent of the input.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}
