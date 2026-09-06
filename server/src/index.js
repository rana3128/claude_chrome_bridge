#!/usr/bin/env node
// Claude Chrome Bridge — MCP server.
//
// Speaks MCP to Claude Code over stdio, and speaks the bridge protocol to the
// Chrome extension over a loopback WebSocket. stdout belongs to MCP: every
// diagnostic goes to stderr.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { Bridge, BridgeError } from './bridge.js';
import { FakeTabBackend } from './fake-tab.js';
import { loadOrCreateToken, TOKEN_PATH } from './token.js';
import { TOOL_DEFINITIONS, Router, createHandlers } from './tools.js';

const VERSION = '0.1.0';
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const verbose = flag('verbose') || process.env.CCB_VERBOSE === '1';
const log = (msg) => process.stderr.write(`[ccb] ${msg}\n`);
const debug = (msg) => { if (verbose) log(msg); };

async function main() {
  const { token } = loadOrCreateToken({ rotate: flag('new-token') });

  const bridge = new Bridge({
    token,
    port: Number(opt('port', process.env.CCB_PORT || 8787)),
    log: debug,
    serverVersion: VERSION,
  });
  const port = await bridge.listen();

  const useFake = process.env.CCB_FAKE_TAB === '1' || flag('fake-tab');
  const fake = useFake ? new FakeTabBackend() : null;
  const router = new Router({ bridge, fake });
  const handlers = createHandlers(router);

  bridge.on('connected', (info) => log(`extension connected (v${info.extensionVersion ?? '?'})`));
  bridge.on('disconnected', () => debug('extension disconnected — this is normal, MV3 workers sleep'));
  bridge.on('extension-event', (name, data) => debug(`event ${name}: ${JSON.stringify(data)}`));

  log(`listening on ws://127.0.0.1:${port} (loopback only)`);
  log(`pairing token file: ${TOKEN_PATH}`);
  if (flag('print-token')) log(`pairing token: ${token}`);
  if (useFake) log('fake in-memory tab enabled (id "fake:1")');

  const server = new Server(
    { name: 'claude-chrome-bridge', version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const handler = handlers[name];
    if (!handler) {
      return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }
    try {
      debug(`tool ${name} ${JSON.stringify(args)}`);
      return await handler(args);
    } catch (e) {
      // Permission refusals and MV3 disconnects are ordinary outcomes here, not
      // crashes: report them as tool errors with a concrete next step.
      const code = e instanceof BridgeError ? e.code : 'internal';
      debug(`tool ${name} failed (${code}): ${e.message}`);
      return { isError: true, content: [{ type: 'text', text: `${name} failed [${code}]: ${e.message}` }] };
    }
  });

  const shutdown = async () => {
    await bridge.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await server.connect(new StdioServerTransport());
  log('MCP server ready on stdio');
}

main().catch((e) => {
  log(`fatal: ${e.stack || e.message}`);
  process.exit(1);
});
