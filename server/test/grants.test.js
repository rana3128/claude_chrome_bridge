import test from 'node:test';
import assert from 'node:assert/strict';

// A minimal chrome stub so the extension's permission store — the security
// core — can be exercised under Node instead of only by hand in a browser.
const badges = new Map();
globalThis.chrome = {
  storage: {
    session: {
      _data: {},
      async get(key) { return key in this._data ? { [key]: this._data[key] } : {}; },
      async set(obj) { Object.assign(this._data, obj); },
    },
  },
  action: {
    async setBadgeText({ tabId, text }) { badges.set(tabId, text); },
    async setBadgeBackgroundColor() {},
    async setTitle() {},
  },
};

const grants = await import('../../extension/lib/grants.js');

const tab = (id, url, title = 'Tab') => ({ id, url, title, windowId: 1 });

test.beforeEach(() => {
  chrome.storage.session._data = {};
  badges.clear();
});

test('a tab is invisible until it is explicitly shared', async () => {
  assert.deepEqual(await grants.list(), []);
  await assert.rejects(() => grants.authorize('read_page', 7), (e) => e.code === 'not_shared');
});

test('sharing grants reading, never control', async () => {
  await grants.share(tab(7, 'https://app.test/dashboard'));
  const grant = await grants.authorize('read_page', 7);
  assert.equal(grant.control, false);
  await assert.rejects(() => grants.authorize('click', 7), (e) => {
    assert.equal(e.code, 'not_controllable');
    assert.match(e.message, /Allow control/);
    return true;
  });
});

test('control is a separate, revocable grant', async () => {
  await grants.share(tab(7, 'https://app.test/dashboard'));
  await grants.setControl(7, true);
  for (const method of ['click', 'type', 'scroll', 'navigate']) {
    assert.ok(await grants.authorize(method, 7), `${method} should be allowed with control`);
  }
  await grants.setControl(7, false);
  await assert.rejects(() => grants.authorize('type', 7), (e) => e.code === 'not_controllable');
});

test('control cannot be granted to a tab that is not shared', async () => {
  await assert.rejects(() => grants.setControl(9, true), /not shared/);
});

test('only http(s) pages can be shared', async () => {
  await assert.rejects(() => grants.share(tab(7, 'chrome://settings')), /Chrome internal pages/);
  await assert.rejects(() => grants.share(tab(8, 'chrome-extension://abc/popup.html')), /Chrome internal pages/);
});

test('sharing one tab does not share any other', async () => {
  await grants.share(tab(7, 'https://app.test/a'));
  await grants.share(tab(8, 'https://other.test/b'));
  await grants.revoke(7);
  await assert.rejects(() => grants.authorize('read_page', 7), (e) => e.code === 'not_shared');
  assert.ok(await grants.authorize('read_page', 8));
});

test('navigating to another origin auto-revokes the share', async () => {
  await grants.share(tab(7, 'https://app.test/login'));
  await grants.setControl(7, true);
  assert.equal(await grants.checkNavigation(7, 'https://evil.test/'), true);
  await assert.rejects(() => grants.authorize('read_page', 7), (e) => e.code === 'not_shared');
});

test('navigating within the shared origin keeps the share and tracks the URL', async () => {
  await grants.share(tab(7, 'https://app.test/login'));
  assert.equal(await grants.checkNavigation(7, 'https://app.test/dashboard'), false);
  const grant = await grants.get(7);
  assert.equal(grant.url, 'https://app.test/dashboard');
  assert.ok(await grants.authorize('read_page', 7));
});

test('re-sharing after a revoke is a fresh, read-only grant', async () => {
  await grants.share(tab(7, 'https://app.test/a'));
  await grants.setControl(7, true);
  await grants.revoke(7, 'origin-change');
  await grants.share(tab(7, 'https://app.test/a'));
  const grant = await grants.get(7);
  assert.equal(grant.control, false, 'control must not survive a revoke');
});

test('an idle share lapses and takes its control grant with it', async () => {
  await grants.share(tab(7, 'https://app.test/a'));
  await grants.setControl(7, true);
  assert.deepEqual(await grants.sweepIdle(Date.now()), []);
  const expired = await grants.sweepIdle(Date.now() + grants.IDLE_TIMEOUT_MS + 1000);
  assert.deepEqual(expired, [7]);
  await assert.rejects(() => grants.authorize('read_page', 7), (e) => e.code === 'not_shared');
});

test('using a tab keeps it from going idle', async () => {
  const start = Date.now();
  await grants.share(tab(7, 'https://app.test/a'));
  await grants.authorize('read_page', 7); // touches lastUsed
  const stale = start + grants.IDLE_TIMEOUT_MS - 1000;
  assert.deepEqual(await grants.sweepIdle(stale), []);
});

test('the panic button revokes everything at once', async () => {
  await grants.share(tab(7, 'https://a.test/'));
  await grants.share(tab(8, 'https://b.test/'));
  await grants.share(tab(9, 'https://c.test/'));
  const revoked = await grants.revokeAll('panic');
  assert.deepEqual(revoked.sort(), [7, 8, 9]);
  assert.deepEqual(await grants.list(), []);
});

test('shared tabs are badged, and revoked tabs are not', async () => {
  await grants.share(tab(7, 'https://a.test/'));
  assert.equal(badges.get(7), 'R');
  await grants.setControl(7, true);
  assert.equal(badges.get(7), 'RW');
  await grants.revoke(7);
  assert.equal(badges.get(7), '');
});

test('list_tabs needs no grant, since it only ever reports shared tabs', async () => {
  assert.equal(await grants.authorize('list_tabs', undefined), null);
});
