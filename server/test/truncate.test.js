import test from 'node:test';
import assert from 'node:assert/strict';
import { truncateText, truncateList, renderList, BUDGETS } from '../src/truncate.js';

test('text within budget is returned untouched', () => {
  const r = truncateText('short', 100);
  assert.equal(r.text, 'short');
  assert.equal(r.truncated, false);
  assert.equal(r.shown, r.total);
});

test('oversized text is cut and the cut is announced with counts', () => {
  const src = 'x'.repeat(5000);
  const r = truncateText(src, 1000, 'Use query() to narrow.');
  assert.equal(r.truncated, true);
  assert.ok(r.text.length < src.length);
  assert.match(r.text, /\[TRUNCATED: showing 1,000 of 5,000 characters \(20%\)\. Use query\(\) to narrow\.\]/);
  assert.equal(r.total, 5000);
});

test('truncation never happens silently', () => {
  const r = truncateText('y'.repeat(3000), 500);
  assert.match(r.text, /TRUNCATED/);
});

test('the cut prefers a line boundary when one is close enough', () => {
  const src = 'line\n'.repeat(400); // 2000 chars
  const r = truncateText(src, 1000);
  const body = r.text.split('\n\n[TRUNCATED')[0];
  assert.equal(body.endsWith('line'), true, 'should not stop mid-token');
});

test('a single enormous line still gets cut at the budget', () => {
  const src = 'z'.repeat(4000);
  const r = truncateText(src, 1000);
  assert.equal(r.shown, 1000);
});

test('lists are capped and the remainder is counted', () => {
  const r = truncateList(Array.from({ length: 500 }, (_, i) => i), 50, 'Narrow the selector.');
  assert.equal(r.items.length, 50);
  assert.equal(r.truncated, true);
  assert.match(r.notice, /showing 50 of 500 items\. Narrow the selector\./);
});

test('short lists carry no notice', () => {
  const r = truncateList([1, 2, 3], 50);
  assert.equal(r.notice, null);
  assert.equal(r.truncated, false);
});

test('renderList applies both the item cap and the character backstop', () => {
  const items = Array.from({ length: 100 }, () => 'q'.repeat(500));
  const out = renderList(items, { limit: 50, charLimit: 2000, hint: 'Narrow it.', render: (s) => s });
  assert.ok(out.length < 3000);
  assert.match(out, /TRUNCATED/);
});

test('renderList reports emptiness explicitly', () => {
  const out = renderList([], { limit: 10, charLimit: 100, render: (s) => s, empty: 'No elements match .foo.' });
  assert.equal(out, 'No elements match .foo.');
});

test('every declared budget is a sane positive number', () => {
  for (const [mode, n] of Object.entries(BUDGETS)) {
    assert.equal(typeof n, 'number', mode);
    assert.ok(n > 1000 && n <= 50000, `${mode} budget out of range: ${n}`);
  }
});
