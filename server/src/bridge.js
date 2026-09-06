import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import {
  parseFrame, welcome, cmd,
  CLOSE_UNAUTHORIZED, CLOSE_BAD_PROTOCOL, CLOSE_REPLACED,
} from '../../extension/lib/protocol.js';
import { tokenMatches } from './token.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const DEFAULT_TIMEOUT_MS = 20000;
const HEARTBEAT_MS = 25000;

/** Thrown for anything the extension refused or could not do. */
export class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

/**
 * The WebSocket half of the bridge. Binds loopback only, requires the pairing
 * token, and holds at most one authenticated extension connection at a time.
 *
 * MV3 service workers are evicted aggressively, so the socket dropping is the
 * normal state of the world here, not an error condition: we simply have no
 * peer until the extension wakes up and reconnects.
 */
export class Bridge extends EventEmitter {
  constructor({ token, port = 8787, host = '127.0.0.1', log = () => {}, serverVersion = '0.1.0' }) {
    super();
    this.token = token;
    this.serverVersion = serverVersion;
    this.port = port;
    this.host = host;
    this.log = log;
    this.wss = null;
    this.peer = null;           // the one authenticated socket
    this.peerInfo = null;
    this.pending = new Map();   // cmd id -> { resolve, reject, timer }
  }

  async listen() {
    // Try a small range so a stale process doesn't wedge startup entirely.
    let lastErr;
    for (let p = this.port; p < this.port + 10; p++) {
      try {
        await this.#bind(p);
        this.port = p;
        return p;
      } catch (e) {
        if (e && e.code === 'EADDRINUSE') { lastErr = e; continue; }
        throw e;
      }
    }
    throw lastErr;
  }

  #bind(port) {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        host: this.host,
        port,
        maxPayload: 32 * 1024 * 1024, // screenshots arrive as base64
        verifyClient: (info, done) => {
          const addr = info.req.socket.remoteAddress;
          if (!LOOPBACK.has(addr)) {
            this.log(`rejected non-loopback connection from ${addr}`);
            return done(false, 403, 'loopback only');
          }
          const origin = info.req.headers.origin;
          // Chrome extensions send a chrome-extension:// origin; anything from a
          // web page origin is a browser tab trying to drive us and is refused.
          if (origin && !origin.startsWith('chrome-extension://')) {
            this.log(`rejected connection with origin ${origin}`);
            return done(false, 403, 'bad origin');
          }
          done(true);
        },
      });
      const onError = (e) => { wss.close(); reject(e); };
      wss.once('error', onError);
      wss.once('listening', () => {
        wss.off('error', onError);
        wss.on('error', (e) => this.log(`ws server error: ${e.message}`));
        this.wss = wss;
        wss.on('connection', (socket, req) => this.#onConnection(socket, req));
        resolve();
      });
    });
  }

  #onConnection(socket, req) {
    let authed = false;
    const authTimer = setTimeout(() => {
      if (!authed) socket.close(CLOSE_UNAUTHORIZED, 'no hello');
    }, 5000);

    socket.on('message', (raw) => {
      const { frame, error } = parseFrame(raw);
      if (error) {
        this.log(`bad frame: ${error}`);
        socket.close(CLOSE_BAD_PROTOCOL, error.slice(0, 100));
        return;
      }
      if (!authed) {
        if (frame.type !== 'hello') {
          socket.close(CLOSE_UNAUTHORIZED, 'hello required');
          return;
        }
        if (!tokenMatches(this.token, frame.token)) {
          this.log(`rejected connection: bad token (from ${req.socket.remoteAddress})`);
          socket.close(CLOSE_UNAUTHORIZED, 'bad token');
          return;
        }
        authed = true;
        clearTimeout(authTimer);
        if (this.peer && this.peer !== socket && this.peer.readyState === socket.OPEN) {
          this.peer.close(CLOSE_REPLACED, 'replaced by a newer connection');
        }
        this.peer = socket;
        this.peerInfo = { extensionVersion: frame.extensionVersion, since: Date.now() };
        socket.send(JSON.stringify(welcome(this.serverVersion, {
          pid: process.pid,
          cwd: process.cwd(),
          port: this.port,
        })));
        this.log(`extension connected (v${frame.extensionVersion ?? '?'})`);
        this.emit('connected', this.peerInfo);
        return;
      }
      this.#onFrame(frame);
    });

    socket.on('pong', () => { socket.isAlive = true; });
    socket.isAlive = true;
    const hb = setInterval(() => {
      if (socket.isAlive === false) { socket.terminate(); return; }
      socket.isAlive = false;
      try { socket.ping(); } catch { /* closing */ }
    }, HEARTBEAT_MS);

    socket.on('close', (code, reason) => {
      clearTimeout(authTimer);
      clearInterval(hb);
      if (this.peer === socket) {
        this.peer = null;
        this.peerInfo = null;
        this.log(`extension disconnected (${code} ${reason || ''})`.trim());
        this.#failAllPending(new BridgeError('disconnected', 'the extension disconnected mid-command'));
        this.emit('disconnected');
      }
    });
    socket.on('error', (e) => this.log(`socket error: ${e.message}`));
  }

  #onFrame(frame) {
    if (frame.type === 'ping') {
      this.peer?.send(JSON.stringify({ type: 'pong' }));
      return;
    }
    if (frame.type === 'pong') return;
    if (frame.type === 'event') {
      this.emit('extension-event', frame.name, frame.data);
      return;
    }
    if (frame.type === 'result') {
      const waiter = this.pending.get(frame.id);
      if (!waiter) return; // late answer to a timed-out command
      this.pending.delete(frame.id);
      clearTimeout(waiter.timer);
      if (frame.ok) waiter.resolve(frame.data);
      else waiter.reject(new BridgeError(frame.error?.code || 'internal', frame.error?.message || 'unknown error'));
    }
  }

  #failAllPending(error) {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }

  isConnected() {
    return Boolean(this.peer && this.peer.readyState === 1);
  }

  /** Send a command to the extension and await its result. */
  call(method, params = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!this.isConnected()) {
      return Promise.reject(new BridgeError(
        'disconnected',
        'The Chrome extension is not connected. Open Chrome, click the Porthole icon, ' +
        'and check that it shows "Connected". The MV3 service worker sleeps — reconnection usually ' +
        'takes a few seconds after the popup is opened.',
      ));
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError('timeout', `${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.peer.send(JSON.stringify(cmd(id, method, params)));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new BridgeError('internal', `failed to send ${method}: ${e.message}`));
      }
    });
  }

  async close() {
    this.#failAllPending(new BridgeError('shutdown', 'server shutting down'));
    if (this.wss) {
      // wss.close() waits for clients to go away on their own; we do not want
      // a sleeping extension to keep the process alive on shutdown.
      for (const client of this.wss.clients) client.terminate();
    }
    await new Promise((resolve) => (this.wss ? this.wss.close(resolve) : resolve()));
    this.peer = null;
  }
}
