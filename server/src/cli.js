// Everything the bridge does other than serve MCP: one-command registration
// with Claude Code, and showing the pairing token.
//
// `claude-chrome-bridge` with no arguments is the MCP server itself, because
// that is how an MCP client launches it. Humans get the subcommands.

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOrCreateToken, TOKEN_PATH } from './token.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = resolve(HERE, '..', '..');
export const EXTENSION_DIR = join(PACKAGE_ROOT, 'extension');
const ENTRY = join(HERE, 'index.js');

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

/**
 * How an MCP client should launch us. Installed from npm, `npx` keeps working
 * when the package updates or moves; from a checkout, only an absolute path
 * can be relied on.
 */
export function launchCommand() {
  const installed = PACKAGE_ROOT.includes(`${'node_modules'}`);
  return installed
    ? { command: 'npx', args: ['-y', 'claude-chrome-bridge'] }
    : { command: process.execPath, args: [ENTRY] };
}

export function printHelp(version) {
  console.log(`
${bold('Porthole')} ${dim(`v${version}`)} — browser access for AI coding agents

  ${bold('claude-chrome-bridge')}              run the MCP server on stdio (what your MCP client does)
  ${bold('claude-chrome-bridge setup')}        register with Claude Code and print setup steps
  ${bold('claude-chrome-bridge pair')}         show the pairing token for the extension
  ${bold('claude-chrome-bridge extension')}    print the folder to "Load unpacked" in Chrome

${bold('Options')}
  --port <n>        WebSocket port to listen on (default 8787, walks forward if taken)
  --new-token       rotate the pairing token (you must re-pair the extension)
  --fake-tab        expose an in-memory fake tab, for trying the tools without Chrome
  --verbose         log bridge activity to stderr
  --name <n>        server name to register as (setup only, default "chrome-bridge")
  --local           register for the current project only (setup only, default is all projects)

${dim(`Token file: ${TOKEN_PATH}`)}
`);
}

export function runPair() {
  const { token } = loadOrCreateToken();
  console.log(`
${bold('Pairing token')}

  ${bold(green(token))}

Click the Porthole icon in Chrome, paste this into "Pairing token", press Pair.
${dim(`Stored at ${TOKEN_PATH} — it is reused until you run with --new-token.`)}
`);
}

export function runExtensionPath() {
  console.log(EXTENSION_DIR);
}

/** Register with Claude Code, idempotently, and tell the user what is left to do. */
export function runSetup(argv) {
  const arg = (flag, fallback) => {
    const i = argv.indexOf(`--${flag}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const name = arg('name', 'chrome-bridge');
  const scope = argv.includes('--local') ? 'local' : 'user';
  const { command, args } = launchCommand();

  console.log(`\n${bold('Porthole — setup')}\n`);

  const hasClaude = spawnSync('claude', ['--version'], { encoding: 'utf8' }).status === 0;
  if (!hasClaude) {
    console.log(`  ${yellow('!')} The \`claude\` CLI is not on PATH, so nothing was registered automatically.`);
    console.log('    Add this to your MCP client\'s config instead:\n');
    console.log(JSON.stringify({ mcpServers: { [name]: { command, args } } }, null, 2));
  } else {
    // Clear any earlier registration of this name so re-running setup is safe
    // and never leaves a shadowed duplicate across scopes.
    for (const s of ['local', 'user', 'project']) {
      const found = spawnSync('claude', ['mcp', 'get', name], { encoding: 'utf8' });
      if (found.status !== 0) break;
      if (spawnSync('claude', ['mcp', 'remove', name, '-s', s], { encoding: 'utf8' }).status !== 0) break;
      console.log(`  ${dim(`removed previous ${s}-scope registration`)}`);
    }
    const add = spawnSync('claude', ['mcp', 'add', '-s', scope, name, '--', command, ...args], { encoding: 'utf8' });
    if (add.status !== 0) {
      console.log(`  ${yellow('!')} registration failed: ${(add.stderr || add.stdout || '').trim()}`);
      process.exit(1);
    }
    console.log(`  ${green('✓')} registered "${name}" at ${scope} scope ` +
      `${dim(scope === 'user' ? '(available in every project)' : '(this project only)')}`);
  }

  const { token } = loadOrCreateToken();
  console.log(`
${bold('Two one-time steps left:')}

  ${bold('1.')} Install the Porthole extension in Chrome
     From the Chrome Web Store, or load this folder unpacked:
     ${dim(EXTENSION_DIR)}

  ${bold('2.')} Pair it — click the Porthole icon and paste:

     ${bold(green(token))}

Then open a tab, click the Porthole icon, and choose "Share this tab".
${dim('Restart any running Claude Code session to pick up the new server.')}
`);
}
