import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { TOOL_DEFINITIONS } from '../src/tools.js';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'src', 'index.js');

// End-to-end over real MCP stdio, driving the in-memory fake tab. This proves
// the whole tool surface — including the permission gates — without Chrome.
async function withClient(fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, '--fake-tab', '--port', String(19000 + Math.floor(Math.random() * 500))],
    env: { ...process.env, CCB_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'ccb-')) },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

const textOf = (res) => res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

test('the server advertises exactly the documented tool surface', async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, TOOL_DEFINITIONS.map((t) => t.name).sort());
    assert.deepEqual(names, [
      'click', 'console_logs', 'list_tabs', 'navigate', 'network_errors',
      'query', 'read_page', 'screenshot_tab', 'scroll', 'type', 'wait_for',
    ]);
    for (const t of tools) {
      assert.ok(t.description.length > 30, `${t.name} needs a real description`);
      assert.equal(t.inputSchema.type, 'object');
    }
  });
});

test('list_tabs shows the shared tab and its read-only status', async () => {
  await withClient(async (client) => {
    const out = textOf(await client.callTool({ name: 'list_tabs', arguments: {} }));
    assert.match(out, /fake:1/);
    assert.match(out, /\[read-only\]/);
    assert.match(out, /Allow control/);
  });
});

test('list_tabs never leaks a token that was sitting in the tab URL', async () => {
  await withClient(async (client) => {
    const out = textOf(await client.callTool({ name: 'list_tabs', arguments: {} }));
    assert.equal(out.includes('abc123def456ghi789'), false);
    assert.match(out, /REDACTED/);
  });
});

test('read_page defaults to the accessibility tree and masks secret fields', async () => {
  await withClient(async (client) => {
    const out = textOf(await client.callTool({ name: 'read_page', arguments: { tabId: 'fake:1' } }));
    assert.match(out, /mode=a11y/);
    assert.match(out, /textbox "Email"/);
    assert.equal(out.includes('hunter2-actual-secret'), false, 'password value leaked');
    assert.equal(out.includes('sk-live-9f8e7d6c5b4a3210zyxw'), false, 'api key leaked');
    assert.match(out, /REDACTED/);
  });
});

test('read_page html mode still masks secrets', async () => {
  await withClient(async (client) => {
    const out = textOf(await client.callTool({ name: 'read_page', arguments: { tabId: 'fake:1', mode: 'html' } }));
    assert.equal(out.includes('hunter2-actual-secret'), false);
  });
});

test('read_page announces truncation when given a small budget', async () => {
  await withClient(async (client) => {
    const out = textOf(await client.callTool({ name: 'read_page', arguments: { tabId: 'fake:1', maxChars: 60 } }));
    assert.match(out, /TRUNCATED: showing \d+ of \d+ characters/);
  });
});

test('query returns attributes with sensitive values masked', async () => {
  await withClient(async (client) => {
    const out = textOf(await client.callTool({ name: 'query', arguments: { tabId: 'fake:1', selector: 'input' } }));
    assert.match(out, /nickname/);
    assert.equal(out.includes('hunter2-actual-secret'), false);
  });
});

test('console_logs redacts credentials and hands back a polling cursor', async () => {
  await withClient(async (client) => {
    const out = textOf(await client.callTool({ name: 'console_logs', arguments: { tabId: 'fake:1' } }));
    assert.match(out, /Uncaught TypeError/);
    assert.equal(/eyJhbGciOiJIUzI1NiJ9\.\w/.test(out), false, 'JWT leaked into console output');
    assert.match(out, /Next poll: console_logs\("fake:1", \{since: \d+\}\)/);
  });
});

test('console_logs can be filtered by level', async () => {
  await withClient(async (client) => {
    const out = textOf(await client.callTool({ name: 'console_logs', arguments: { tabId: 'fake:1', level: 'error' } }));
    assert.match(out, /1 entry/);
    assert.match(out, /Uncaught TypeError/);
    assert.equal(out.includes('app booted'), false);
  });
});

test('network_errors reports failures with CORS and CSP detail, URLs scrubbed', async () => {
  await withClient(async (client) => {
    const out = textOf(await client.callTool({ name: 'network_errors', arguments: { tabId: 'fake:1' } }));
    assert.match(out, /500 Internal Server Error/);
    assert.match(out, /CORS/);
    assert.match(out, /CSP/);
    assert.equal(out.includes('secret-value-here'), false);
  });
});

test('screenshot_tab returns an image plus size metadata', async () => {
  await withClient(async (client) => {
    const res = await client.callTool({ name: 'screenshot_tab', arguments: { tabId: 'fake:1' } });
    const image = res.content.find((c) => c.type === 'image');
    assert.ok(image, 'expected an image content block');
    assert.equal(image.mimeType, 'image/jpeg');
    assert.ok(image.data.length > 0);
    assert.match(textOf(res), /debugging this browser/);
  });
});

test('control tools are refused on a tab that is only shared for reading', async () => {
  await withClient(async (client) => {
    for (const [name, args] of [
      ['click', { tabId: 'fake:1', selector: '#save' }],
      ['type', { tabId: 'fake:1', selector: '#nickname', text: 'hi' }],
      ['scroll', { tabId: 'fake:1', direction: 'bottom' }],
      ['navigate', { tabId: 'fake:1', url: 'https://example.test/' }],
    ]) {
      const res = await client.callTool({ name, arguments: args });
      assert.equal(res.isError, true, `${name} should be refused without control`);
      assert.match(textOf(res), /not_controllable/);
      assert.match(textOf(res), /Allow control/);
    }
  });
});

test('read-only tools work on a tab with no control grant', async () => {
  await withClient(async (client) => {
    for (const [name, args] of [
      ['read_page', { tabId: 'fake:1' }],
      ['query', { tabId: 'fake:1', selector: 'input' }],
      ['wait_for', { tabId: 'fake:1', selector: '#save' }],
    ]) {
      const res = await client.callTool({ name, arguments: args });
      assert.notEqual(res.isError, true, `${name} should not require control`);
    }
  });
});

test('addressing a real tab while the extension is asleep explains why', async () => {
  await withClient(async (client) => {
    const res = await client.callTool({ name: 'read_page', arguments: { tabId: 42 } });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /not connected/);
    assert.match(textOf(res), /Porthole icon/);
  });
});

test('bad arguments produce a message, not a crash', async () => {
  await withClient(async (client) => {
    const res = await client.callTool({ name: 'click', arguments: { tabId: 'fake:1' } });
    assert.match(textOf(res), /requires either a `selector`/);
  });
});
