import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFrame, hello, cmd, ok, err, event, welcome,
  PROTOCOL_VERSION, isControlMethod, isKnownMethod,
} from '../../extension/lib/protocol.js';

const round = (frame) => parseFrame(JSON.stringify(frame));

test('valid frames round-trip through parseFrame', () => {
  for (const frame of [
    hello('tok', '0.1.0'),
    welcome('0.1.0'),
    cmd('id-1', 'read_page', { mode: 'a11y' }),
    ok('id-1', { content: 'hi' }),
    err('id-1', 'not_shared', 'nope'),
    event('grants.changed', { tabId: 4 }),
    { type: 'ping' },
    { type: 'pong' },
  ]) {
    const { frame: parsed, error } = round(frame);
    assert.equal(error, undefined, `unexpected error for ${frame.type}: ${error}`);
    assert.deepEqual(parsed, frame);
  }
});

test('malformed input is rejected, never thrown', () => {
  const cases = [
    ['not json', 'not valid JSON'],
    ['[]', 'must be a JSON object'],
    ['null', 'must be a JSON object'],
    ['{}', 'unknown frame type'],
    ['{"type":"nope"}', 'unknown frame type'],
  ];
  for (const [raw, needle] of cases) {
    const res = parseFrame(raw);
    assert.equal(res.frame, undefined);
    assert.match(res.error, new RegExp(needle));
  }
});

test('hello requires a token and a matching protocol version', () => {
  assert.match(round({ type: 'hello', protocolVersion: PROTOCOL_VERSION }).error, /requires a token/);
  assert.match(round({ type: 'hello', protocolVersion: PROTOCOL_VERSION, token: '' }).error, /requires a token/);
  assert.match(round({ type: 'hello', protocolVersion: 99, token: 't' }).error, /version mismatch/);
});

test('cmd frames must carry an id and a known method', () => {
  assert.match(round({ type: 'cmd', method: 'read_page' }).error, /string id/);
  assert.match(round({ type: 'cmd', id: 'x', method: 'rm_rf' }).error, /unknown method/);
  assert.match(round({ type: 'cmd', id: 'x', method: 'click', params: 'oops' }).error, /params must be an object/);
});

test('result frames must be well formed', () => {
  assert.match(round({ type: 'result', ok: true }).error, /string id/);
  assert.match(round({ type: 'result', id: 'x' }).error, /boolean ok/);
  assert.match(round({ type: 'result', id: 'x', ok: false }).error, /error\.message/);
});

test('control methods are exactly the mutating ones', () => {
  for (const m of ['click', 'type', 'scroll', 'navigate']) {
    assert.equal(isControlMethod(m), true, `${m} must be control-gated`);
    assert.equal(isKnownMethod(m), true);
  }
  for (const m of ['list_tabs', 'screenshot_tab', 'read_page', 'query', 'console_logs', 'network_errors', 'wait_for']) {
    assert.equal(isControlMethod(m), false, `${m} must not require control`);
    assert.equal(isKnownMethod(m), true);
  }
  assert.equal(isKnownMethod('eval'), false);
});
