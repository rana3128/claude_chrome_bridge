// The outbound WebSocket link to the MCP server.
//
// The extension always dials *out*; the browser never listens on a port. And
// because an MV3 service worker is evicted whenever Chrome feels like it, a
// dropped socket is the normal state of this system rather than a failure:
// everything here is built to reconnect quietly and keep working.

import { hello, parseFrame, ok, err, CLOSE_UNAUTHORIZED } from './protocol.js';
import * as grants from './grants.js';
import { HANDLERS } from './commands.js';

export const DEFAULT_PORT = 8787;
// The server walks forward from its default port if one is taken, so the
// extension sweeps the same small range instead of making the user hunt.
const PORT_SPAN = 10;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;
const PING_MS = 20000;

let socket = null;
let attempts = 0;
let reconnectTimer = null;
let pingTimer = null;
let state = { status: 'disconnected', since: Date.now(), lastError: null, port: null };
const watchers = new Set();

export function getState() {
  return { ...state, connected: state.status === 'connected' };
}

export function onStateChange(fn) {
  watchers.add(fn);
  return () => watchers.delete(fn);
}

function setState(patch) {
  state = { ...state, ...patch, since: Date.now() };
  for (const fn of watchers) {
    try { fn(getState()); } catch { /* a watcher must not break the socket */ }
  }
}

async function settings() {
  const s = await chrome.storage.local.get(['token', 'port']);
  return { token: s.token || '', port: Number(s.port) || DEFAULT_PORT };
}

export async function setToken(token) {
  await chrome.storage.local.set({ token: String(token || '').trim() });
  attempts = 0;
  reconnect(0);
}

export async function setPort(port) {
  await chrome.storage.local.set({ port: Number(port) || DEFAULT_PORT });
  attempts = 0;
  reconnect(0);
}

function backoffMs() {
  const exp = Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS);
  return exp * (0.7 + Math.random() * 0.6); // jitter, so many wakeups don't sync up
}

export function reconnect(delay = backoffMs()) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connect(), delay);
}

export async function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  const { token, port } = await settings();
  if (!token) {
    setState({ status: 'no-token', lastError: 'Paste the pairing token from the MCP server to finish setup.' });
    return;
  }

  // Sweep the port range the server may have landed on.
  const candidate = port + (attempts % PORT_SPAN);
  setState({ status: 'connecting', port: candidate, lastError: null });

  let ws;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${candidate}`);
  } catch (e) {
    setState({ status: 'disconnected', lastError: e.message });
    attempts++;
    reconnect();
    return;
  }
  socket = ws;

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify(hello(token, chrome.runtime.getManifest().version)));
  });

  ws.addEventListener('message', (ev) => onMessage(ws, ev.data));

  ws.addEventListener('close', (ev) => {
    clearInterval(pingTimer);
    if (socket === ws) socket = null;
    if (ev.code === CLOSE_UNAUTHORIZED) {
      // A wrong token will stay wrong. Stop hammering and ask the user.
      setState({
        status: 'unauthorized',
        lastError: 'The server rejected this token. Copy the current token from ~/.claude-chrome-bridge/token.json and paste it again.',
      });
      return;
    }
    attempts++;
    setState({ status: 'disconnected', lastError: ev.reason || null });
    reconnect();
  });

  ws.addEventListener('error', () => {
    // The close event follows and carries the useful information.
  });
}

function onMessage(ws, raw) {
  const { frame, error } = parseFrame(raw);
  if (error) return;

  if (frame.type === 'welcome') {
    attempts = 0;
    setState({ status: 'connected', lastError: null });
    clearInterval(pingTimer);
    // Traffic on the socket also keeps the service worker from being evicted.
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    }, PING_MS);
    return;
  }
  if (frame.type === 'pong' || frame.type === 'ping') return;
  if (frame.type === 'cmd') void handleCommand(ws, frame);
}

async function handleCommand(ws, frame) {
  const { id, method, params = {} } = frame;
  try {
    // Permission is checked here, on every single command, from the store —
    // never from anything the server told us.
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
  clearTimeout(reconnectTimer);
  clearInterval(pingTimer);
  if (socket) {
    try { socket.close(1000, 'extension shutting down'); } catch { /* already closed */ }
    socket = null;
  }
  setState({ status: 'disconnected' });
}

export function notifyServer(name, data) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'event', name, data }));
  }
}
