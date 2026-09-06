// chrome.debugger session management.
//
// The debugger API is what makes this tool work at all: it gives full DevTools
// Protocol access to a tab inside the user's real, already-logged-in Chrome,
// with no --remote-debugging-port relaunch and no lost sessions.
//
// Chrome shows its own "…is debugging this browser" banner whenever we are
// attached. That banner is a feature. Nothing here tries to hide or work
// around it.

import { redactText, redactUrl } from './redact.js';

const PROTOCOL = '1.3';
const MAX_CONSOLE = 500;
const MAX_NETWORK = 300;
const BUFFER_KEY = 'cdpBuffers';

/** tabId -> { attachedAt, console: [], network: [], inflight: Map } */
const sessions = new Map();
let flushTimer = null;

// The MV3 worker can be evicted while the debugger stays attached, which would
// otherwise drop every buffered log. Buffers are mirrored into session storage.
async function restoreBuffers() {
  const stored = await chrome.storage.session.get(BUFFER_KEY);
  for (const [tabId, buf] of Object.entries(stored[BUFFER_KEY] || {})) {
    if (!sessions.has(Number(tabId))) {
      sessions.set(Number(tabId), { attachedAt: buf.attachedAt, console: buf.console || [], network: buf.network || [], inflight: new Map(), restored: true });
    }
  }
}
const restored = restoreBuffers();

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    const out = {};
    for (const [tabId, s] of sessions) {
      out[tabId] = { attachedAt: s.attachedAt, console: s.console, network: s.network };
    }
    try { await chrome.storage.session.set({ [BUFFER_KEY]: out }); } catch { /* quota or shutdown */ }
  }, 1000);
}

function push(list, entry, cap) {
  list.push(entry);
  if (list.length > cap) list.splice(0, list.length - cap);
  scheduleFlush();
}

export function isAttached(tabId) {
  const s = sessions.get(tabId);
  return Boolean(s && !s.restored);
}

export async function attach(tabId) {
  await restored;
  if (isAttached(tabId)) return sessions.get(tabId);
  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL);
  } catch (e) {
    const msg = String(e?.message || e);
    if (/already attached|Another debugger/i.test(msg)) {
      const err = new Error(
        `Cannot attach to tab ${tabId}: another debugger is already attached. This is almost always an open ` +
        'DevTools window on that tab — close DevTools (or use a different tab) and try again. Chrome allows ' +
        'only one debugger client per tab.',
      );
      err.code = 'devtools_conflict';
      throw err;
    }
    if (/Cannot access|cannot be debugged|chrome:\/\//i.test(msg)) {
      const err = new Error(`Cannot attach to tab ${tabId}: ${msg}. Chrome internal pages and the Web Store cannot be inspected by extensions.`);
      err.code = 'debugger_failed';
      throw err;
    }
    const err = new Error(`Cannot attach to tab ${tabId}: ${msg}`);
    err.code = 'debugger_failed';
    throw err;
  }

  const existing = sessions.get(tabId);
  const session = {
    attachedAt: Date.now(),
    console: existing?.console || [],
    network: existing?.network || [],
    inflight: new Map(),
    frames: new Map(), // sessionId -> targetInfo, for cross-origin iframes
  };
  sessions.set(tabId, session);

  // Cross-origin iframes are separate CDP targets. Flat auto-attach gives us a
  // sessionId per OOPIF so their content can be read too, instead of silently
  // showing up as an empty box in the page.
  try {
    await send(tabId, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  } catch { /* older Chrome, or a target that has no children */ }

  // Enable only the domains we actually read. Console and network capture is
  // the whole point of attaching; DOM/Page are needed for reads and input.
  for (const domain of ['Runtime.enable', 'Log.enable', 'Network.enable', 'Page.enable', 'DOM.enable']) {
    try { await send(tabId, domain); } catch { /* a domain may be unavailable on some targets */ }
  }
  return session;
}

export async function detach(tabId) {
  sessions.delete(tabId);
  scheduleFlush();
  try { await chrome.debugger.detach({ tabId }); } catch { /* already gone */ }
}

export async function detachAll() {
  const targets = await chrome.debugger.getTargets().catch(() => []);
  for (const t of targets) {
    if (t.attached && t.tabId != null && sessions.has(t.tabId)) {
      try { await chrome.debugger.detach({ tabId: t.tabId }); } catch { /* ignore */ }
    }
  }
  sessions.clear();
  scheduleFlush();
}

export async function send(tabId, method, params = {}, sessionId) {
  const target = sessionId ? { tabId, sessionId } : { tabId };
  return chrome.debugger.sendCommand(target, method, params);
}

/** Attach if needed, then run `fn`. Sessions are kept warm so logs keep flowing. */
export async function withSession(tabId, fn) {
  await attach(tabId);
  return fn();
}

export function getConsole(tabId, since = 0) {
  const s = sessions.get(tabId);
  if (!s) return { entries: [], attachedAt: null };
  return { entries: s.console.filter((e) => e.ts > since), attachedAt: s.attachedAt };
}

/** sessionIds of the cross-origin iframes attached under this tab. */
export function getFrameSessions(tabId) {
  const s = sessions.get(tabId);
  if (!s || !s.frames) return [];
  return [...s.frames.entries()].map(([sessionId, info]) => ({ sessionId, url: info.url, type: info.type }));
}

export function getNetwork(tabId, since = 0) {
  const s = sessions.get(tabId);
  if (!s) return { entries: [] };
  return { entries: s.network.filter((e) => e.ts > since) };
}

// ----------------------------------------------------------- CDP events ----

function textOfArgs(args = []) {
  return args
    .map((a) => {
      if (a.type === 'string') return a.value;
      if ('value' in a) return JSON.stringify(a.value);
      if (a.description) return a.description;
      return a.type;
    })
    .join(' ');
}

function frameOf(stackTrace) {
  const f = stackTrace?.callFrames?.[0];
  return f ? { url: f.url, line: f.lineNumber + 1 } : {};
}

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  const tabId = source.tabId;
  if (tabId == null) return;
  await restored;
  const s = sessions.get(tabId);
  if (!s) return;
  s.restored = false;

  switch (method) {
    case 'Target.attachedToTarget':
      if (params.targetInfo?.type === 'iframe') {
        s.frames.set(params.sessionId, params.targetInfo);
        // Child sessions need their own domain enables to report anything.
        for (const domain of ['Runtime.enable', 'Log.enable', 'Network.enable']) {
          send(tabId, domain, {}, params.sessionId).catch(() => {});
        }
      }
      break;

    case 'Target.detachedFromTarget':
      s.frames.delete(params.sessionId);
      break;

    case 'Runtime.consoleAPICalled':
      push(s.console, {
        ts: Date.now(),
        level: params.type === 'warning' ? 'warn' : params.type,
        text: redactText(textOfArgs(params.args)).slice(0, 2000),
        ...frameOf(params.stackTrace),
      }, MAX_CONSOLE);
      break;

    case 'Runtime.exceptionThrown': {
      const d = params.exceptionDetails || {};
      push(s.console, {
        ts: Date.now(),
        level: 'error',
        text: redactText(d.exception?.description || d.text || 'uncaught exception').slice(0, 2000),
        url: d.url,
        line: (d.lineNumber ?? 0) + 1,
      }, MAX_CONSOLE);
      break;
    }

    case 'Log.entryAdded': {
      const e = params.entry || {};
      const entry = {
        ts: Date.now(),
        level: e.level === 'warning' ? 'warn' : e.level,
        text: redactText(e.text || '').slice(0, 2000),
        url: e.url ? redactUrl(e.url) : undefined,
        line: e.lineNumber != null ? e.lineNumber + 1 : undefined,
        source: e.source,
      };
      push(s.console, entry, MAX_CONSOLE);
      // CSP and mixed-content violations arrive here rather than on Network.
      if (e.source === 'security' || /Content Security Policy|CORS|blocked/i.test(e.text || '')) {
        push(s.network, {
          ts: entry.ts,
          method: '-',
          url: entry.url || '',
          status: 0,
          statusText: 'blocked',
          type: e.source,
          failure: entry.text,
        }, MAX_NETWORK);
      }
      break;
    }

    case 'Network.requestWillBeSent':
      s.inflight.set(params.requestId, {
        ts: Date.now(),
        method: params.request?.method,
        url: redactUrl(params.request?.url || ''),
        type: params.type,
      });
      break;

    case 'Network.responseReceived': {
      const req = s.inflight.get(params.requestId) || {};
      const status = params.response?.status ?? 0;
      // Only failures are retained; successful traffic would swamp the output.
      if (status >= 400) {
        push(s.network, {
          ...req,
          ts: Date.now(),
          status,
          statusText: params.response?.statusText || '',
          type: params.type || req.type,
        }, MAX_NETWORK);
      }
      s.inflight.delete(params.requestId);
      break;
    }

    case 'Network.loadingFailed': {
      const req = s.inflight.get(params.requestId) || {};
      if (!params.canceled) {
        const cors = params.corsErrorStatus?.corsError;
        push(s.network, {
          ...req,
          ts: Date.now(),
          status: 0,
          statusText: params.errorText || 'failed',
          type: params.type || req.type,
          failure: cors ? `CORS: ${cors}` : params.blockedReason ? `blocked: ${params.blockedReason}` : params.errorText,
        }, MAX_NETWORK);
      }
      s.inflight.delete(params.requestId);
      break;
    }

    default:
      break;
  }
});

// The user can end a debugging session from Chrome's own banner. That is a
// revocation, and it must be honoured immediately.
const detachListeners = new Set();
export function onDetach(fn) { detachListeners.add(fn); }

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId == null) return;
  sessions.delete(source.tabId);
  scheduleFlush();
  for (const fn of detachListeners) {
    try { fn(source.tabId, reason); } catch { /* keep going */ }
  }
});
