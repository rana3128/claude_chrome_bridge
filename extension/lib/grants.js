// The permission store — the security core of the extension.
//
// Nothing is visible to Claude until the user shares that specific tab, and
// sharing grants reading only. Control (clicking, typing, navigating) is a
// second, separate grant. Grants live in session storage, so they die with the
// browser session and can never silently outlive it.

import { CONTROL_METHODS } from './protocol.js';

const KEY = 'grants';
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // sharing lapses after 30 idle minutes

const listeners = new Set();

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(reason) {
  for (const fn of listeners) {
    try { fn(reason); } catch { /* a listener must not break revocation */ }
  }
}

async function readAll() {
  const stored = await chrome.storage.session.get(KEY);
  return stored[KEY] || {};
}

async function writeAll(grants, reason) {
  await chrome.storage.session.set({ [KEY]: grants });
  await syncBadges(grants);
  notify(reason);
}

export function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

export async function list() {
  const grants = await readAll();
  return Object.values(grants).sort((a, b) => a.sharedAt - b.sharedAt);
}

export async function get(tabId) {
  const grants = await readAll();
  return grants[String(tabId)] || null;
}

export async function share(tab) {
  const origin = originOf(tab.url);
  if (!origin || !/^https?:|^file:/.test(origin + ':')) {
    // chrome://, chrome-extension:// and the Web Store are off limits to both
    // the debugger and scripting, so refuse clearly rather than half-sharing.
    if (!/^https?:/.test(tab.url || '')) {
      throw new Error('Only http(s) pages can be shared. Chrome internal pages are not accessible to extensions.');
    }
  }
  const grants = await readAll();
  const now = Date.now();
  const existing = grants[String(tab.id)];
  grants[String(tab.id)] = {
    tabId: tab.id,
    windowId: tab.windowId,
    origin,
    url: tab.url,
    title: tab.title,
    sharedAt: existing?.sharedAt ?? now,
    lastUsed: now,
    control: existing?.control ?? false,
  };
  await writeAll(grants, 'shared');
  return grants[String(tab.id)];
}

export async function setControl(tabId, control) {
  const grants = await readAll();
  const grant = grants[String(tabId)];
  if (!grant) throw new Error('That tab is not shared, so control cannot be granted.');
  grant.control = Boolean(control);
  grant.lastUsed = Date.now();
  await writeAll(grants, control ? 'control-granted' : 'control-revoked');
  return grant;
}

export async function revoke(tabId, reason = 'user') {
  const grants = await readAll();
  if (!grants[String(tabId)]) return false;
  delete grants[String(tabId)];
  await writeAll(grants, `revoked:${reason}`);
  await clearBadge(tabId);
  return true;
}

export async function revokeAll(reason = 'panic') {
  const grants = await readAll();
  const ids = Object.keys(grants);
  await chrome.storage.session.set({ [KEY]: {} });
  for (const id of ids) await clearBadge(Number(id));
  notify(`revoked-all:${reason}`);
  return ids.map(Number);
}

export async function touch(tabId) {
  const grants = await readAll();
  const grant = grants[String(tabId)];
  if (!grant) return;
  grant.lastUsed = Date.now();
  await chrome.storage.session.set({ [KEY]: grants });
}

/**
 * Gate one command. Throws with a code the server maps straight into the tool
 * error, so a refusal reads as a refusal and not as a crash.
 */
export async function authorize(method, tabId) {
  if (method === 'list_tabs') return null;
  const grant = await get(tabId);
  if (!grant) {
    const e = new Error(
      `Tab ${tabId} is not shared. The user must open that tab, click the Porthole icon and ` +
      'choose "Share this tab". Sharing is per-tab and deliberate.',
    );
    e.code = 'not_shared';
    throw e;
  }
  if (CONTROL_METHODS.has(method) && !grant.control) {
    const e = new Error(
      `Tab ${tabId} is shared for reading only. "${method}" needs the "Allow control" toggle, which the user ` +
      'must enable separately in the extension popup.',
    );
    e.code = 'not_controllable';
    throw e;
  }
  await touch(tabId);
  return grant;
}

/** Auto-revoke: a navigation that leaves the shared origin ends the share. */
export async function checkNavigation(tabId, url) {
  const grant = await get(tabId);
  if (!grant || !url) return;
  const origin = originOf(url);
  if (origin && origin !== grant.origin) {
    await revoke(tabId, 'origin-change');
    return true;
  }
  // Same origin: keep the share but refresh the recorded URL/title.
  const grants = await readAll();
  if (grants[String(tabId)]) {
    grants[String(tabId)].url = url;
    await chrome.storage.session.set({ [KEY]: grants });
  }
  return false;
}

/** Auto-revoke: sharing lapses when nobody has used it for a while. */
export async function sweepIdle(now = Date.now()) {
  const grants = await readAll();
  const expired = Object.values(grants).filter((g) => now - g.lastUsed > IDLE_TIMEOUT_MS);
  for (const g of expired) await revoke(g.tabId, 'idle');
  return expired.map((g) => g.tabId);
}

// ---------------------------------------------------------------- badges ----
// A shared tab must look shared. The badge is per-tab, so an unshared tab is
// visibly unmarked.

export async function syncBadges(grants) {
  const all = grants || (await readAll());
  for (const grant of Object.values(all)) {
    try {
      await chrome.action.setBadgeText({ tabId: grant.tabId, text: grant.control ? 'RW' : 'R' });
      await chrome.action.setBadgeBackgroundColor({ tabId: grant.tabId, color: grant.control ? '#B4501E' : '#3B7A57' });
      await chrome.action.setTitle({
        tabId: grant.tabId,
        title: grant.control
          ? 'Porthole — shared, Claude can read AND control this tab'
          : 'Porthole — shared read-only with Claude',
      });
    } catch { /* the tab may have closed mid-sync */ }
  }
}

export async function clearBadge(tabId) {
  try {
    await chrome.action.setBadgeText({ tabId, text: '' });
    await chrome.action.setTitle({ tabId, title: 'Porthole' });
  } catch { /* tab gone */ }
}
