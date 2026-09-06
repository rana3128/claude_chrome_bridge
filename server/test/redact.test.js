import test from 'node:test';
import assert from 'node:assert/strict';
import { isSensitiveField, redactText, redactFieldValue, redactDeep, redactUrl, MASK } from '../../extension/lib/redact.js';

test('password inputs are always sensitive, whatever they are named', () => {
  assert.equal(isSensitiveField({ type: 'password' }), true);
  assert.equal(isSensitiveField({ type: 'PASSWORD', name: 'friendly' }), true);
  assert.equal(redactFieldValue({ type: 'password' }, 'hunter2'), MASK);
});

test('secret-sounding field names and autocomplete hints are sensitive', () => {
  for (const d of [
    { type: 'text', name: 'apiKey' },
    { type: 'text', id: 'user_secret' },
    { type: 'text', placeholder: 'Enter your token' },
    { type: 'text', ariaLabel: 'CVV' },
    { type: 'text', autocomplete: 'one-time-code' },
    { type: 'text', autocomplete: 'current-password' },
  ]) {
    assert.equal(isSensitiveField(d), true, `should be sensitive: ${JSON.stringify(d)}`);
  }
});

test('ordinary fields are not masked', () => {
  assert.equal(isSensitiveField({ type: 'text', name: 'nickname' }), false);
  assert.equal(isSensitiveField({ type: 'email', name: 'email' }), false);
  assert.equal(redactFieldValue({ type: 'text', name: 'nickname' }, 'Vijay'), 'Vijay');
});

test('secret-shaped values are masked wherever they appear in text', () => {
  const cases = [
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    'sk-live-9f8e7d6c5b4a3210zyxw',
    'ghp_16C7e42F292c6912E7710c838347Ae178B4a',
    'xoxb-1234567890-abcdefghijkl',
    'AKIAIOSFODNN7EXAMPLE',
    'Authorization: Bearer abcdef1234567890abcdef',
    'password="correct horse battery"',
  ];
  for (const raw of cases) {
    const out = redactText(raw);
    assert.match(out, /REDACTED/, `not redacted: ${raw}`);
    assert.ok(!out.includes(raw), `original survived redaction: ${raw}`);
  }
});

test('a PEM private key block is removed entirely', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\nzzz\n-----END RSA PRIVATE KEY-----';
  const out = redactText(`key:\n${pem}\ndone`);
  assert.equal(out.includes('MIIEow'), false);
  assert.match(out, /REDACTED:private-key/);
});

test('ordinary prose survives redaction unchanged', () => {
  const prose = 'Uncaught TypeError: user.profile is undefined at app.js:214';
  assert.equal(redactText(prose), prose);
  assert.equal(redactText('Welcome back, Vijay. You have 3 new messages.'), 'Welcome back, Vijay. You have 3 new messages.');
});

test('tokens in URL query strings and fragments are masked', () => {
  assert.match(redactUrl('https://x.test/cb?code=abc123&state=ok'), /code=%5BREDACTED%5D/);
  assert.match(redactUrl('https://x.test/a?access_token=zzz'), /access_token=%5BREDACTED%5D/);
  assert.match(redactUrl('https://x.test/#access_token=zzz&t=1'), /REDACTED:fragment/);
  assert.equal(redactUrl('https://x.test/page?tab=security'), 'https://x.test/page?tab=security');
  assert.equal(redactUrl('not a url at all'), 'not a url at all');
});

test('redactDeep masks by key name and by value shape, at any depth', () => {
  const out = redactDeep({
    user: 'vijay',
    password: 'hunter2',
    nested: { apiKey: 'plainish', list: ['AKIAIOSFODNN7EXAMPLE', 'fine'] },
  });
  assert.equal(out.user, 'vijay');
  assert.equal(out.password, MASK);
  assert.equal(out.nested.apiKey, MASK);
  assert.match(out.nested.list[0], /REDACTED/);
  assert.equal(out.nested.list[1], 'fine');
});

test('redactDeep terminates on deeply nested and cyclic-ish structures', () => {
  let node = { v: 'AKIAIOSFODNN7EXAMPLE' };
  for (let i = 0; i < 40; i++) node = { child: node };
  assert.doesNotThrow(() => redactDeep(node));
});
