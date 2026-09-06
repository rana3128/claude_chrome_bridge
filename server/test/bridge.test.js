import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { Bridge } from '../src/bridge.js';
import { parseFrame, hello, ok } from '../../extension/lib/protocol.js';
import { tokenMatches } from '../src/token.js';

const TOKEN = 'test-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

async function withBridge(fn) {
  const bridge = new Bridge({ token: TOKEN, port: 18800 + Math.floor(Math.random() * 400) });
  const port = await bridge.listen();
  try {
    await fn(bridge, port);
  } finally {
    await bridge.close();
  }
}

function connect(port, { origin = 'chrome-extension://abcdef' } = {}) {
  return new WebSocket(`ws://127.0.0.1:${port}`, { origin, headers: { Origin: origin } });
}

function nextFrame(socket) {
  return new Promise((resolve, reject) => {
    socket.once('message', (raw) => resolve(parseFrame(raw).frame));
    socket.once('close', (code, reason) => reject(Object.assign(new Error('closed'), { code, reason: String(reason) })));
  });
}

test('token comparison is exact and rejects near-misses', () => {
  assert.equal(tokenMatches(TOKEN, TOKEN), true);
  assert.equal(tokenMatches(TOKEN, TOKEN + 'x'), false);
  assert.equal(tokenMatches(TOKEN, TOKEN.slice(0, -1)), false);
  assert.equal(tokenMatches(TOKEN, ''), false);
  assert.equal(tokenMatches(TOKEN, undefined), false);
});

test('a connection with the wrong token is closed unauthorized', async () => {
  await withBridge(async (bridge, port) => {
    const socket = connect(port);
    await new Promise((r) => socket.once('open', r));
    socket.send(JSON.stringify(hello('wrong-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbb', '0.1.0')));
    const closed = await new Promise((r) => socket.once('close', (code) => r(code)));
    assert.equal(closed, 4401);
    assert.equal(bridge.isConnected(), false);
  });
});

test('a connection that skips hello is closed unauthorized', async () => {
  await withBridge(async (bridge, port) => {
    const socket = connect(port);
    await new Promise((r) => socket.once('open', r));
    socket.send(JSON.stringify({ type: 'ping' }));
    const code = await new Promise((r) => socket.once('close', (c) => r(c)));
    assert.equal(code, 4401);
  });
});

test('a malformed frame closes the socket rather than being ignored', async () => {
  await withBridge(async (bridge, port) => {
    const socket = connect(port);
    await new Promise((r) => socket.once('open', r));
    socket.send('}{not json');
    const code = await new Promise((r) => socket.once('close', (c) => r(c)));
    assert.equal(code, 4400);
  });
});

test('a web page origin is refused at the handshake', async () => {
  await withBridge(async (bridge, port) => {
    const socket = connect(port, { origin: 'https://evil.test' });
    const err = await new Promise((r) => {
      socket.once('error', r);
      socket.once('open', () => r(null));
    });
    assert.ok(err, 'connection from a page origin should not open');
    assert.equal(bridge.isConnected(), false);
  });
});

test('an authenticated extension can answer commands', async () => {
  await withBridge(async (bridge, port) => {
    const socket = connect(port);
    await new Promise((r) => socket.once('open', r));
    socket.send(JSON.stringify(hello(TOKEN, '0.1.0')));
    const wel = await nextFrame(socket);
    assert.equal(wel.type, 'welcome');

    socket.on('message', (raw) => {
      const { frame } = parseFrame(raw);
      if (frame?.type === 'cmd') socket.send(JSON.stringify(ok(frame.id, { tabs: [{ tabId: 7 }] })));
    });

    assert.equal(bridge.isConnected(), true);
    const res = await bridge.call('list_tabs', {});
    assert.deepEqual(res, { tabs: [{ tabId: 7 }] });
  });
});

test('an extension refusal surfaces as a coded error', async () => {
  await withBridge(async (bridge, port) => {
    const socket = connect(port);
    await new Promise((r) => socket.once('open', r));
    socket.send(JSON.stringify(hello(TOKEN, '0.1.0')));
    await nextFrame(socket);
    socket.on('message', (raw) => {
      const { frame } = parseFrame(raw);
      if (frame?.type === 'cmd') {
        socket.send(JSON.stringify({ type: 'result', id: frame.id, ok: false, error: { code: 'not_shared', message: 'tab 7 is not shared' } }));
      }
    });
    await assert.rejects(() => bridge.call('read_page', { tabId: 7 }), (e) => {
      assert.equal(e.code, 'not_shared');
      assert.match(e.message, /not shared/);
      return true;
    });
  });
});

test('calls made while the extension is asleep fail with actionable guidance', async () => {
  await withBridge(async (bridge) => {
    await assert.rejects(() => bridge.call('list_tabs', {}), (e) => {
      assert.equal(e.code, 'disconnected');
      assert.match(e.message, /not connected/);
      return true;
    });
  });
});

test('a pending call is rejected when the service worker goes to sleep', async () => {
  await withBridge(async (bridge, port) => {
    const socket = connect(port);
    await new Promise((r) => socket.once('open', r));
    socket.send(JSON.stringify(hello(TOKEN, '0.1.0')));
    await nextFrame(socket);
    const pending = bridge.call('read_page', { tabId: 7 });
    socket.terminate();
    await assert.rejects(() => pending, (e) => e.code === 'disconnected');
  });
});

test('an unanswered call times out instead of hanging forever', async () => {
  await withBridge(async (bridge, port) => {
    const socket = connect(port);
    await new Promise((r) => socket.once('open', r));
    socket.send(JSON.stringify(hello(TOKEN, '0.1.0')));
    await nextFrame(socket);
    await assert.rejects(() => bridge.call('read_page', { tabId: 7 }, { timeoutMs: 120 }), (e) => {
      assert.equal(e.code, 'timeout');
      return true;
    });
  });
});

test('a reconnecting worker replaces the stale connection', async () => {
  await withBridge(async (bridge, port) => {
    const first = connect(port);
    await new Promise((r) => first.once('open', r));
    first.send(JSON.stringify(hello(TOKEN, '0.1.0')));
    await nextFrame(first);

    const second = connect(port);
    await new Promise((r) => second.once('open', r));
    second.send(JSON.stringify(hello(TOKEN, '0.1.0')));
    await nextFrame(second);

    const firstClose = await new Promise((r) => first.once('close', (c) => r(c)));
    assert.equal(firstClose, 4409);
    assert.equal(bridge.isConnected(), true);
  });
});
