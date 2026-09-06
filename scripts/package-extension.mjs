#!/usr/bin/env node
// Build the .zip to upload to the Chrome Web Store.
//
// Verifies the manifest first: a version mismatch or a stray permission is far
// cheaper to catch here than after a multi-day review.

import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'extension');
const OUT_DIR = join(ROOT, 'dist');

const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const problems = [];
if (manifest.version !== pkg.version) {
  problems.push(`manifest version ${manifest.version} does not match package version ${pkg.version}`);
}
if (!manifest.description || manifest.description.length > 132) {
  problems.push(`description must be 1-132 characters (currently ${manifest.description?.length ?? 0})`);
}
for (const size of ['16', '48', '128']) {
  if (!existsSync(join(EXT, manifest.icons?.[size] ?? ''))) problems.push(`missing icon ${size}`);
}
const EXPECTED = ['tabs', 'activeTab', 'scripting', 'debugger', 'storage', 'alarms'];
const extra = (manifest.permissions || []).filter((p) => !EXPECTED.includes(p));
if (extra.length) problems.push(`unexpected permissions (each one costs review time): ${extra.join(', ')}`);
if (manifest.host_permissions?.length) {
  problems.push('host_permissions should stay empty — everything runs through the debugger and activeTab');
}

if (problems.length) {
  console.error('Cannot package:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
const zipPath = join(OUT_DIR, `porthole-${manifest.version}.zip`);
rmSync(zipPath, { force: true });

// Exclude nothing but OS cruft: the whole point is that a reviewer, or any
// user, can read every line that ships.
execFileSync('zip', ['-r', '-q', zipPath, '.', '-x', '.DS_Store', '-x', '__MACOSX/*'], { cwd: EXT });

const size = (readFileSync(zipPath).length / 1024).toFixed(1);
console.log(`\n  ${zipPath}  (${size} KB)\n`);
console.log('  Upload at https://chrome.google.com/webstore/devconsole');
console.log('  Listing copy and permission justifications: STORE_LISTING.md\n');
