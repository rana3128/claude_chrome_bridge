// Service worker entry point.
//
// MV3 will evict this worker at will. Nothing here may assume it stays alive:
// grants live in session storage, the socket reconnects on its own, and an
// alarm wakes us periodically to re-dial and to expire idle shares.

import * as connection from './lib/connection.js';
import * as grants from './lib/grants.js';
import * as cdp from './lib/cdp.js';

const KEEPALIVE_ALARM = 'ccb-keepalive';

async function ensureAlarm() {
  await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
}

async function boot(reason) {
  await ensureAlarm();
  await grants.syncBadges();
  await connection.connect();
  console.log(`[ccb] service worker started (${reason})`);
}

chrome.runtime.onStartup.addListener(() => boot('browser startup'));
chrome.runtime.onInstalled.addListener(async (details) => {
  await boot('installed');
  // A first-time user has no idea a server has to be running; show them.
  if (details.reason === 'install') {
    await chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  }
});
boot('worker wake');

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  await connection.connect();          // no-op when already connected
  const expired = await grants.sweepIdle();
  for (const tabId of expired) await cdp.detach(tabId);
});

// ------------------------------------------------------------ auto-revoke ---

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (await grants.revoke(tabId, 'tab-closed')) await cdp.detach(tabId);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const revoked = await grants.checkNavigation(tabId, changeInfo.url);
  if (revoked) {
    await cdp.detach(tabId);
    connection.notifyServer('grant.revoked', { tabId, reason: 'origin-change' });
  }
});

// The user can end a debugging session from Chrome's own banner. Treat that as
// what it is: a revocation of sharing.
cdp.onDetach(async (tabId, reason) => {
  if (reason === 'canceled_by_user' || reason === 'target_closed') {
    await grants.revoke(tabId, `debugger-detached:${reason}`);
    connection.notifyServer('grant.revoked', { tabId, reason });
  }
});

grants.onChange((reason) => connection.notifyServer('grants.changed', { reason }));

// ---------------------------------------------------------------- popup ----

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'get-state': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          return sendResponse({
            ok: true,
            connection: connection.getState(),
            grants: await grants.list(),
            activeTab: tab ? { id: tab.id, title: tab.title, url: tab.url, shareable: /^https?:/.test(tab.url || '') } : null,
            idleTimeoutMinutes: Math.round(grants.IDLE_TIMEOUT_MS / 60000),
          });
        }
        case 'share': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab) throw new Error('no active tab');
          const grant = await grants.share(tab);
          // Attaching now means Chrome's own "is debugging" banner appears the
          // moment sharing starts, and console/network capture begins at once.
          // If it fails, the share is rolled back: a grant the user was told
          // did not happen must not linger.
          try {
            await cdp.attach(tab.id);
          } catch (e) {
            await grants.revoke(tab.id, 'attach-failed');
            throw new Error(`Could not start capture on this tab: ${e.message}`);
          }
          connection.notifyServer('grants.changed', { reason: 'shared', tabId: tab.id });
          return sendResponse({ ok: true, grant });
        }
        case 'unshare':
          await grants.revoke(msg.tabId, 'user');
          await cdp.detach(msg.tabId);
          return sendResponse({ ok: true });
        case 'set-control':
          await grants.setControl(msg.tabId, msg.control);
          return sendResponse({ ok: true });
        case 'panic': {
          const revoked = await grants.revokeAll('panic');
          await cdp.detachAll();
          connection.notifyServer('grants.changed', { reason: 'panic' });
          return sendResponse({ ok: true, revoked });
        }
        case 'set-token':
          await connection.setToken(msg.token);
          return sendResponse({ ok: true });
        case 'set-port':
          await connection.setPort(msg.port);
          return sendResponse({ ok: true });
        case 'reconnect':
          await connection.reconnect(0);
          return sendResponse({ ok: true, connection: connection.getState() });
        default:
          return sendResponse({ ok: false, error: `unknown message: ${msg.type}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // async response
});
