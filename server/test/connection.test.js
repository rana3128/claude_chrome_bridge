import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../src/bridge.js';

// The extension's connection layer, driven against real Bridge servers.
//
// This is the regression test for the bug that made a second Claude Code
// session permanently blind: every session runs its own MCP server on its own
// port, and the extension used to connect to exactly one of them.

const TOKEN = 'connection-test-token-cccccccccccccccc';
const BASE = 19500 + Math.floor(Math.random() * 300) * 10;

const listeners = { addListener() {}, removeListener() {} };
const local = { _d: {}, async get(keys) {
  const out = {};
  for (const k of [].concat(keys)) if (k in this._d) out[k] = this._d[k];
  return out;
}, async set(o) { Object.assign(this._d, o); } };
const session = { _d: {}, async get(k) { return k in this._d ? { [k]: this._d[k] } : {}; }, async set(o) { Object.assign(this._d, o); } };

globalThis.chrome = {
  storage: { local, session },
  action: { async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {} },
  debugger: { onEvent: listeners, onDetach: listeners, async attach() {}, async detach() {}, async sendCommand() { return {}; }, async getTargets() { return []; } },
  tabs: {
    _tabs: { 7: { id: 7, url: 'https://app.test/dash', title: 'Dashboard', windowId: 1, active: true } },
    async get(id) {
      if (!this._tabs[id]) throw new Error('No tab with id ' + id);
      return this._tabs[id];
    },
    onRemoved: listeners, onUpdated: listeners,
  },
  alarms: { async create() {}, onAlarm: listeners },
  runtime: { getManifest: () => ({ version: '0.1.0' }), onMessage: listeners, onStartup: listeners, onInstalled: listeners },
  scripting: {},
};

const connection = await import('../../extension/lib/connection.js');
const grants = await import('../../extension/lib/grants.js');

const servers = [];
async function startServer(port) {
  const bridge = new Bridge({ token: TOKEN, port, serverVersion: `v-${port}` });
  await bridge.listen();
  servers.push(bridge);
  return bridge;
}

async function waitFor(predicate, { timeout = 5000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test.after(async () => {
  connection.disconnect();
  for (const s of servers) await s.close();
});

test('the extension connects to every server in the port range, not just the first', async () => {
  const a = await startServer(BASE);
  const b = await startServer(BASE + 1);

  await local.set({ token: TOKEN, port: BASE });
  await connection.connect();

  await waitFor(() => a.isConnected() && b.isConnected(), { label: 'both servers to be connected' });

  const state = connection.getState();
  assert.equal(state.status, 'connected');
  assert.equal(state.servers.length, 2, 'both servers should appear as connected links');
  assert.deepEqual(state.servers.map((s) => s.port).sort(), [BASE, BASE + 1]);
});

test('each connected server is identified by pid and working directory', async () => {
  const state = connection.getState();
  for (const s of state.servers) {
    assert.equal(s.server.pid, process.pid);
    assert.equal(s.server.cwd, process.cwd());
    assert.equal(s.server.version, `v-${s.port}`);
  }
});

test('a second session sees the same shared tabs as the first', async () => {
  const [a, b] = servers;
  await grants.share({ id: 7, url: 'https://app.test/dash', title: 'Dashboard', windowId: 1 });

  for (const [name, server] of [['first', a], ['second', b]]) {
    const res = await server.call('list_tabs', {});
    assert.equal(res.tabs.length, 1, `${name} server should see the shared tab`);
    assert.equal(res.tabs[0].tabId, 7);
    assert.equal(res.tabs[0].control, false);
  }
});

test('permission is enforced per command on every connection', async () => {
  const [a, b] = servers;
  await assert.rejects(() => a.call('read_page', { tabId: 999 }), (e) => e.code === 'not_shared');
  await assert.rejects(() => b.call('click', { tabId: 7, selector: '#go' }), (e) => e.code === 'not_controllable');

  await grants.setControl(7, true);
  // Now allowed by the grant — it fails later, in the stubbed CDP layer, which
  // is what proves the gate itself opened.
  await assert.rejects(() => b.call('click', { tabId: 7, selector: '#go' }), (e) => e.code !== 'not_controllable');
  await grants.setControl(7, false);
});

test('losing one server leaves the other working', async () => {
  const [a, b] = servers;
  await a.close();
  servers.splice(0, 1);

  await waitFor(() => connection.getState().servers.length === 1, { label: 'the dead link to be dropped' });
  assert.equal(connection.getState().status, 'connected');
  const res = await b.call('list_tabs', {});
  assert.equal(res.tabs.length, 1, 'the surviving server should still work');
});

test('a dial to a dead port gives up instead of holding the slot forever', async () => {
  // Without a dial deadline these entries stay "connecting" for good, and the
  // port is never retried — which is how a later-started server stays unseen.
  const stuck = await waitFor(() => {
    const s = connection.getState();
    return s.links.every((l) => l.status === 'connected') ? s : null;
  }, { timeout: 8000, label: 'dead-port dials to be abandoned' });
  assert.equal(stuck.links.length, 1);
});

test('a server started later is picked up by a sweep', async () => {
  const c = await startServer(BASE + 5);
  await waitFor(async () => {
    await connection.connect(); // what the keepalive alarm does periodically
    await new Promise((r) => setTimeout(r, 300));
    return c.isConnected();
  }, { timeout: 8000, label: 'the newly started server to be found' });
  assert.equal(connection.getState().servers.length, 2);
});

test('Reconnect redials everything immediately', async () => {
  await connection.reconnect(0);
  await waitFor(() => connection.getState().servers.length === 2, { label: 'links to be re-established' });
  assert.equal(connection.getState().status, 'connected');
});

test('a rejected token stops the sweep and asks the user to re-pair', async () => {
  await local.set({ token: 'wrong-token-dddddddddddddddddddddddd' });
  await connection.reconnect(0);
  const state = await waitFor(() => {
    const s = connection.getState();
    return s.status === 'unauthorized' ? s : null;
  }, { label: 'the unauthorized state' });
  assert.match(state.lastError, /token/i);
  assert.equal(state.servers.length, 0);
});
