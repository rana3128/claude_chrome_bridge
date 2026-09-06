// Canonical wire protocol shared by the MCP server and the extension.
// The extension loads this file directly; the server imports it by relative
// path (see DECISIONS.md) so there is exactly one copy of the rules.

export const PROTOCOL_VERSION = 1;

// Every frame is a JSON object with a `type`. Command/result frames carry an
// `id` that the server allocates and the extension echoes back verbatim.
export const FRAME_TYPES = ['hello', 'welcome', 'cmd', 'result', 'event', 'ping', 'pong'];

export const CLOSE_UNAUTHORIZED = 4401;
export const CLOSE_BAD_PROTOCOL = 4400;
export const CLOSE_REPLACED = 4409;

export const ERROR_CODES = {
  NOT_SHARED: 'not_shared',
  NOT_CONTROLLABLE: 'not_controllable',
  NO_SUCH_TAB: 'no_such_tab',
  DEVTOOLS_CONFLICT: 'devtools_conflict',
  DEBUGGER_FAILED: 'debugger_failed',
  TIMEOUT: 'timeout',
  NOT_FOUND: 'not_found',
  UNSUPPORTED: 'unsupported',
  INTERNAL: 'internal',
};

// Commands that mutate the page. These require the per-tab "Allow control"
// grant on top of the share grant; everything else is read-only.
export const CONTROL_METHODS = new Set(['click', 'type', 'scroll', 'navigate']);

export const READ_METHODS = new Set([
  'list_tabs',
  'screenshot_tab',
  'read_page',
  'query',
  'console_logs',
  'network_errors',
  'wait_for',
]);

export function isControlMethod(method) {
  return CONTROL_METHODS.has(method);
}

export function isKnownMethod(method) {
  return CONTROL_METHODS.has(method) || READ_METHODS.has(method);
}

export function hello(token, extensionVersion) {
  return { type: 'hello', protocolVersion: PROTOCOL_VERSION, token, extensionVersion };
}

export function welcome(serverVersion) {
  return { type: 'welcome', protocolVersion: PROTOCOL_VERSION, serverVersion };
}

export function cmd(id, method, params = {}) {
  return { type: 'cmd', id, method, params };
}

export function ok(id, data) {
  return { type: 'result', id, ok: true, data };
}

export function err(id, code, message) {
  return { type: 'result', id, ok: false, error: { code, message } };
}

export function event(name, data) {
  return { type: 'event', name, data };
}

/**
 * Parse and structurally validate an inbound frame.
 * Returns { frame } or { error } — never throws, because both ends of this
 * link treat malformed input as hostile rather than exceptional.
 */
export function parseFrame(raw) {
  let frame;
  try {
    frame = JSON.parse(typeof raw === 'string' ? raw : String(raw));
  } catch {
    return { error: 'frame is not valid JSON' };
  }
  if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) {
    return { error: 'frame must be a JSON object' };
  }
  if (typeof frame.type !== 'string' || !FRAME_TYPES.includes(frame.type)) {
    return { error: `unknown frame type: ${String(frame.type)}` };
  }
  switch (frame.type) {
    case 'hello':
      if (typeof frame.token !== 'string' || frame.token.length === 0) {
        return { error: 'hello requires a token' };
      }
      if (frame.protocolVersion !== PROTOCOL_VERSION) {
        return { error: `protocol version mismatch: server ${PROTOCOL_VERSION}, client ${frame.protocolVersion}` };
      }
      break;
    case 'cmd':
      if (typeof frame.id !== 'string' || !frame.id) return { error: 'cmd requires a string id' };
      if (!isKnownMethod(frame.method)) return { error: `unknown method: ${String(frame.method)}` };
      if (frame.params !== undefined && (typeof frame.params !== 'object' || frame.params === null)) {
        return { error: 'cmd params must be an object' };
      }
      break;
    case 'result':
      if (typeof frame.id !== 'string' || !frame.id) return { error: 'result requires a string id' };
      if (typeof frame.ok !== 'boolean') return { error: 'result requires a boolean ok' };
      if (frame.ok === false && (!frame.error || typeof frame.error.message !== 'string')) {
        return { error: 'failed result requires error.message' };
      }
      break;
    case 'event':
      if (typeof frame.name !== 'string' || !frame.name) return { error: 'event requires a name' };
      break;
    default:
      break;
  }
  return { frame };
}
