// The outbound WebSocket links to the MCP server(s).
//
// The extension always dials *out*; the browser never listens on a port.
//
// Every Claude Code session spawns its own MCP server, and they land on
// consecutive ports. So this connects to *all* of them at once rather than
// picking one: a session that lost the race for port 8787 would otherwise be
// permanently blind, with no way for the user to tell why. Each link is
// independent — commands are answered on the socket they arrived on.
//
// An MV3 service worker is evicted whenever Chrome feels like it, so a dropped
// socket is the normal state of this system rather than a failure.

import { hello, parseFrame, ok, err, CLOSE_UNAUTHORIZED } from './protocol.js';
import * as grants from './grants.js';
import { HANDLERS } from './commands.js';

export const DEFAULT_PORT = 8787;
// The server walks forward from its default port when one is taken, so this is
// the window in which any server can be found.
export const PORT_SPAN = 10;

const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;
const IDLE_DISCOVERY_MS = 20000; // re-sweep for known ports once we have one
// Chrome logs every refused WebSocket dial to the console and there is no way
// to catch or silence it, so probing all ten ports every 20s buries real errors
// under a wall of ERR_CONNECTION_REFUSED. Ports that have hosted a server
// before are always retried; unknown ports are probed one per sweep in
// rotation, which keeps the noise to roughly one line per sweep while still
// finding a new session on its own within a couple of minutes. Reconnect
// probes the whole range at once.
const PING_MS = 20000;
// A dial to a port with nothing behind it does not reliably report failure —
// no close event ever arrives. Without a deadline that slot stays "connecting"
// for good and is never retried, so a server started later is never found.
const DIAL_TIMEOUT_MS = 3000;

/** port -> { ws, status, server, pingTimer } */
const links = new Map();
/** Ports a server has actually answered on, remembered across worker restarts. */
let knownPorts = new Set();
let coldCursor = 0;
let sweeps = 0;
let sweepTimer = null;
let unauthorized = false;
let tokenMissing = true;
let lastError = null;
const watchers = new Set();

export function getState() {
  const list = [...links.entries()]
    .map(([port, l]) => ({ port, status: l.status, server: l.server || null }))
    .sort((a, b) => a.port - b.port);
  const connected = list.filter((l) => l.status === 'connected');

  let status = 'disconnected';
  // Without a token there is nothing to report but that. Letting this fall
  // through to "disconnected" told the user their server was missing and hid
  // the pairing form, leaving no way to recover through the UI.
  if (tokenMissing) status = 'no-token';
  else if (unauthorized) status = 'unauthorized';
  else if (connected.length) status = 'connected';
  else if (list.some((l) => l.status === 'connecting')) status = 'connecting';

  return {
    status,
    connected: connected.length > 0,
    servers: connected,
    links: list,
    port: connected[0]?.port ?? null,
    lastError,
  };
}

export function onStateChange(fn) {
  watchers.add(fn);
  return () => watchers.delete(fn);
}

function announce() {
  const state = getState();
  for (const fn of watchers) {
    try { fn(state); } catch { /* a watcher must not break the socket */ }
  }
}

async function settings() {
  const s = await chrome.storage.local.get(['token', 'port', 'knownPorts']);
  if (Array.isArray(s.knownPorts) && !knownPorts.size) knownPorts = new Set(s.knownPorts);
  return { token: s.token || '', port: Number(s.port) || DEFAULT_PORT };
}

async function rememberPort(port) {
  if (knownPorts.has(port)) return;
  knownPorts.add(port);
  await chrome.storage.local.set({ knownPorts: [...knownPorts] });
}

export async function setToken(token) {
  await chrome.storage.local.set({ token: String(token || '').trim() });
  unauthorized = false;
  lastError = null;
  await reconnect(0);
}

export async function setPort(port) {
  await chrome.storage.local.set({ port: Number(port) || DEFAULT_PORT });
  dropAll('port changed');
  await reconnect(0);
}

function backoffMs() {
  const exp = Math.min(BASE_BACKOFF_MS * 2 ** sweeps, MAX_BACKOFF_MS);
  return exp * (0.7 + Math.random() * 0.6); // jitter, so many wakeups don't sync up
}

function scheduleSweep(delay) {
  clearTimeout(sweepTimer);
  if (unauthorized) return; // a wrong token will stay wrong; wait for the user
  const anyConnected = [...links.values()].some((l) => l.status === 'connected');
  sweepTimer = setTimeout(() => void connect(), delay ?? (anyConnected ? IDLE_DISCOVERY_MS : backoffMs()));
}

/** Forced, immediate redial of everything — what the popup's Reconnect does. */
export async function reconnect(delay = 0) {
  sweeps = 0;
  unauthorized = false;
  clearTimeout(sweepTimer);
  if (delay > 0) return scheduleSweep(delay);
  return connect({ force: true });
}

function dropAll(reason) {
  for (const [port, link] of links) {
    clearInterval(link.pingTimer);
    clearTimeout(link.dialTimer);
    try { link.ws?.close(1000, reason); } catch { /* already gone */ }
    links.delete(port);
  }
}

/** Dial every port in the range that we do not already have a live link on. */
export async function connect({ force = false } = {}) {
  const { token, port: base } = await settings();
  tokenMissing = !token;
  if (!token) {
    lastError = 'Run `npx claude-chrome-bridge pair` and paste the token below.';
    unauthorized = false;
    dropAll('not paired');
    announce();
    return;
  }
  if (force) dropAll('reconnecting');

  sweeps++;
  const version = chrome.runtime.getManifest().version;
  // Reconnect probes everything; a routine sweep probes the base port, every
  // port a server has answered on before, and one unknown port in rotation.
  const probe = new Set([base, ...knownPorts]);
  if (force) {
    for (let i = 0; i < PORT_SPAN; i++) probe.add(base + i);
  } else {
    for (let i = 0; i < PORT_SPAN; i++) {
      const port = base + ((coldCursor + i) % PORT_SPAN);
      if (!probe.has(port)) { probe.add(port); coldCursor = (port - base + 1) % PORT_SPAN; break; }
    }
  }

  for (const port of [...probe].sort((a, b) => a - b)) {
    const existing = links.get(port);
    if (existing && (existing.status === 'connected' || existing.status === 'connecting')) continue;
    dial(port, token, version);
  }
  announce();
  scheduleSweep();
}

function dial(port, token, version) {
  let ws;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}`);
  } catch (e) {
    links.set(port, { status: 'disconnected', error: e.message });
    return;
  }
  const link = { ws, status: 'connecting', server: null, pingTimer: null, dialTimer: null };
  links.set(port, link);

  link.dialTimer = setTimeout(() => {
    if (link.status === 'connected') return;
    try { ws.close(1000, 'dial timed out'); } catch { /* already gone */ }
    if (links.get(port) === link) links.delete(port);
    announce();
  }, DIAL_TIMEOUT_MS);

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify(hello(token, version)));
  });

  ws.addEventListener('message', (ev) => onMessage(port, ws, ev.data));

  ws.addEventListener('close', (ev) => {
    clearInterval(link.pingTimer);
    clearTimeout(link.dialTimer);
    if (links.get(port)?.ws !== ws) return; // superseded by a newer dial
    if (ev.code === CLOSE_UNAUTHORIZED) {
      // Same token everywhere, so one rejection means all of them will reject.
      unauthorized = true;
      lastError = 'The server rejected this token. Copy the current token from ~/.claude-chrome-bridge/token.json and paste it again.';
      links.delete(port);
      announce();
      return;
    }
    links.delete(port);
    announce();
    scheduleSweep();
  });

  // The close event follows an error and carries the useful information.
  ws.addEventListener('error', () => {});
}

function onMessage(port, ws, raw) {
  const { frame, error } = parseFrame(raw);
  if (error) return;
  const link = links.get(port);
  if (!link || link.ws !== ws) return;

  if (frame.type === 'welcome') {
    sweeps = 0;
    unauthorized = false;
    lastError = null;
    link.status = 'connected';
    link.server = { ...(frame.server || {}), version: frame.serverVersion };
    void rememberPort(port);
    clearTimeout(link.dialTimer);
    clearInterval(link.pingTimer);
    // Traffic on the socket also keeps the service worker from being evicted.
    link.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    }, PING_MS);
    announce();
    scheduleSweep();
    return;
  }
  if (frame.type === 'pong' || frame.type === 'ping') return;
  if (frame.type === 'cmd') void handleCommand(ws, frame);
}

async function handleCommand(ws, frame) {
  const { id, method, params = {} } = frame;
  try {
    // Permission is checked here, on every single command, from the store —
    // never from anything a server told us. Several servers may be connected;
    // none of them is more trusted than any other.
    await grants.authorize(method, params.tabId);
    const handler = HANDLERS[method];
    if (!handler) throw Object.assign(new Error(`unsupported method: ${method}`), { code: 'unsupported' });
    const data = await handler(params);
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ok(id, data)));
  } catch (e) {
    const code = e?.code || 'internal';
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(err(id, code, e?.message || String(e))));
    }
  }
}

export function disconnect() {
  clearTimeout(sweepTimer);
  dropAll('extension shutting down');
  announce();
}

/** Tell every connected server about a change in what is shared. */
export function notifyServer(name, data) {
  for (const link of links.values()) {
    if (link.ws?.readyState === WebSocket.OPEN) {
      link.ws.send(JSON.stringify({ type: 'event', name, data }));
    }
  }
}
