// Output-size budgeting. A browser tool that dumps everything it sees is worse
// than no browser tool at all, so every payload that leaves this process passes
// through here and every cut leaves an explicit, actionable marker behind.

export const BUDGETS = {
  a11y: 12000,
  text: 12000,
  html: 8000,
  query: 8000,
  console: 10000,
  network: 8000,
  default: 12000,
};

export const MAX_QUERY_MATCHES = 50;
export const MAX_LOG_ENTRIES = 200;

function fmt(n) {
  return n.toLocaleString('en-US');
}

/**
 * Cut `text` to `limit` characters, appending a marker that says what was lost
 * and how to get the rest. Never truncates silently.
 * @returns {{text: string, truncated: boolean, shown: number, total: number}}
 */
export function truncateText(text, limit = BUDGETS.default, hint = '') {
  const source = typeof text === 'string' ? text : String(text ?? '');
  if (source.length <= limit) {
    return { text: source, truncated: false, shown: source.length, total: source.length };
  }
  // Prefer to break on a line boundary so the tail isn't a half-token.
  let cut = source.lastIndexOf('\n', limit);
  if (cut < limit * 0.6) cut = limit;
  const head = source.slice(0, cut);
  const marker =
    `\n\n[TRUNCATED: showing ${fmt(head.length)} of ${fmt(source.length)} characters ` +
    `(${Math.round((head.length / source.length) * 100)}%).` +
    (hint ? ` ${hint}` : '') +
    ']';
  return { text: head + marker, truncated: true, shown: head.length, total: source.length };
}

/**
 * Cap a list of items and say how many were dropped.
 * @returns {{items: Array, truncated: boolean, shown: number, total: number, notice: string|null}}
 */
export function truncateList(items, limit, hint = '') {
  const all = Array.isArray(items) ? items : [];
  if (all.length <= limit) {
    return { items: all, truncated: false, shown: all.length, total: all.length, notice: null };
  }
  const kept = all.slice(0, limit);
  return {
    items: kept,
    truncated: true,
    shown: kept.length,
    total: all.length,
    notice:
      `[TRUNCATED: showing ${fmt(kept.length)} of ${fmt(all.length)} items.` +
      (hint ? ` ${hint}` : '') +
      ']',
  };
}

/**
 * Render a list result as text with its notice attached, then apply the
 * character budget as a second backstop (items can be individually huge).
 */
export function renderList(items, { limit, charLimit, hint, render, empty = '(none)' }) {
  const capped = truncateList(items, limit, hint);
  const body = capped.items.length ? capped.items.map(render).join('\n') : empty;
  const withNotice = capped.notice ? `${body}\n${capped.notice}` : body;
  return truncateText(withNotice, charLimit, hint).text;
}
