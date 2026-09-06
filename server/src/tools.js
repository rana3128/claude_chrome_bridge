// MCP tool definitions and their handlers. Everything Claude can see or do to
// a browser tab is in this file.
//
// Two rules hold for every handler:
//   1. The extension is the authority on permission. The server asks; the
//      extension decides and can always say no.
//   2. Nothing leaves here unbudgeted. Payloads pass through truncate.js, and
//      anything textual passes through the redaction rules a second time.

import { redactText, redactUrl, redactDeep } from '../../extension/lib/redact.js';
import { BUDGETS, MAX_LOG_ENTRIES, MAX_QUERY_MATCHES, truncateText, renderList } from './truncate.js';

const TAB_ID = {
  anyOf: [{ type: 'number' }, { type: 'string' }],
  description: 'Tab id from list_tabs. Only tabs the user has explicitly shared are addressable.',
};

export const TOOL_DEFINITIONS = [
  {
    name: 'list_tabs',
    description:
      'List the Chrome tabs the user has explicitly shared with Claude. Shows tab id, title, URL, and whether ' +
      'control (clicking/typing/navigating) is allowed on each. Tabs the user has not shared are invisible here ' +
      'by design — if a tab you expect is missing, ask the user to click the extension icon and "Share this tab".',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'screenshot_tab',
    description:
      'Capture a screenshot of a shared tab. Downscaled and JPEG-compressed by default to stay within the ' +
      'context budget. Use fullPage for content below the fold.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: TAB_ID,
        fullPage: { type: 'boolean', description: 'Capture the whole scrollable page, not just the viewport. Default false.' },
        maxWidth: { type: 'number', description: 'Downscale to at most this many CSS pixels wide. Default 1280.' },
        format: { type: 'string', enum: ['jpeg', 'png'], description: 'Default jpeg (quality 70). Use png only when exact pixels matter.' },
      },
      required: ['tabId'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_page',
    description:
      'Read the content of a shared tab. mode="a11y" (default) returns the accessibility tree — compact, ' +
      'semantically meaningful, and the right choice almost always. mode="text" returns visible text. ' +
      'mode="html" returns raw HTML and is a last resort: it is large and mostly noise. ' +
      'Password fields and secret-looking values are always masked.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: TAB_ID,
        mode: { type: 'string', enum: ['a11y', 'text', 'html'], description: 'Default "a11y".' },
        selector: { type: 'string', description: 'Restrict the read to the subtree matching this CSS selector.' },
        maxChars: { type: 'number', description: 'Override the default output budget for this call.' },
      },
      required: ['tabId'],
      additionalProperties: false,
    },
  },
  {
    name: 'query',
    description:
      'Return the text and attributes of elements matching a CSS selector in a shared tab. Use this to drill ' +
      'into a specific region after read_page, instead of re-reading the whole page.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: TAB_ID,
        selector: { type: 'string', description: 'CSS selector.' },
        limit: { type: 'number', description: `Max matches to return. Default ${MAX_QUERY_MATCHES}.` },
      },
      required: ['tabId', 'selector'],
      additionalProperties: false,
    },
  },
  {
    name: 'console_logs',
    description:
      'Console output and uncaught exceptions captured from a shared tab via the Chrome DevTools Protocol. ' +
      'Pass `since` (epoch ms, from a previous response) to poll for new entries only.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: TAB_ID,
        since: { type: 'number', description: 'Only entries newer than this epoch-ms timestamp.' },
        level: { type: 'string', enum: ['error', 'warning', 'info', 'log', 'all'], description: 'Default "all".' },
      },
      required: ['tabId'],
      additionalProperties: false,
    },
  },
  {
    name: 'network_errors',
    description:
      'Failed and non-2xx network requests from a shared tab, including CORS and CSP violations. Only errors ' +
      'are reported — successful requests are omitted to keep the output small.',
    inputSchema: {
      type: 'object',
      properties: { tabId: TAB_ID, since: { type: 'number', description: 'Only entries newer than this epoch-ms timestamp.' } },
      required: ['tabId'],
      additionalProperties: false,
    },
  },
  {
    name: 'click',
    description: 'Click an element (CSS selector) or a viewport coordinate. Requires the per-tab "Allow control" toggle.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: TAB_ID,
        selector: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
      },
      required: ['tabId'],
      additionalProperties: false,
    },
  },
  {
    name: 'type',
    description:
      'Type text into the element matching a selector. Requires "Allow control". Typing into a password field ' +
      'is permitted but the value is never echoed back.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: TAB_ID,
        selector: { type: 'string' },
        text: { type: 'string' },
        submit: { type: 'boolean', description: 'Press Enter afterwards. Default false.' },
        clear: { type: 'boolean', description: 'Clear the field first. Default true.' },
      },
      required: ['tabId', 'selector', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'scroll',
    description: 'Scroll a shared tab to an element or a position. Requires "Allow control".',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: TAB_ID,
        selector: { type: 'string', description: 'Scroll this element into view.' },
        x: { type: 'number' },
        y: { type: 'number' },
        direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] },
      },
      required: ['tabId'],
      additionalProperties: false,
    },
  },
  {
    name: 'wait_for',
    description:
      'Wait until a selector appears, or until a navigation completes. Returns as soon as the condition holds. ' +
      'Read-only: waiting does not require "Allow control".',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: TAB_ID,
        selector: { type: 'string' },
        navigation: { type: 'boolean', description: 'Wait for the next navigation to finish loading.' },
        timeout: { type: 'number', description: 'Milliseconds. Default 10000, max 60000.' },
      },
      required: ['tabId'],
      additionalProperties: false,
    },
  },
  {
    name: 'navigate',
    description: 'Navigate a shared tab to a URL. Requires "Allow control". Navigating to a different origin revokes sharing.',
    inputSchema: {
      type: 'object',
      properties: { tabId: TAB_ID, url: { type: 'string' }, waitForLoad: { type: 'boolean', description: 'Default true.' } },
      required: ['tabId', 'url'],
      additionalProperties: false,
    },
  },
];

function text(s) {
  return { content: [{ type: 'text', text: s }] };
}

function fmtTs(ts) {
  return typeof ts === 'number' ? new Date(ts).toISOString().slice(11, 23) : '?';
}

/**
 * Routes a tool call to the right backend: fake tab ids go to the in-memory
 * pretend browser, everything else goes over the WebSocket to the extension.
 */
export class Router {
  constructor({ bridge, fake }) {
    this.bridge = bridge;
    this.fake = fake;
  }

  #isFake(tabId) {
    return this.fake && typeof tabId === 'string' && tabId.startsWith('fake:');
  }

  call(tabId, method, params, opts) {
    if (this.#isFake(tabId)) return this.fake.call(method, { ...params, tabId });
    return this.bridge.call(method, { ...params, tabId }, opts);
  }

  async listTabs() {
    const tabs = [];
    if (this.fake) {
      const res = await this.fake.call('list_tabs', {});
      tabs.push(...res.tabs);
    }
    if (this.bridge.isConnected()) {
      try {
        const res = await this.bridge.call('list_tabs', {});
        tabs.push(...(res.tabs || []));
      } catch (e) {
        tabs.push({ error: e.message });
      }
    }
    return tabs;
  }

  connectionNote() {
    if (this.bridge.isConnected()) return null;
    return 'The Chrome extension is not connected right now. Chrome MV3 puts the extension to sleep; it ' +
      'reconnects on its own within a few seconds, or immediately if the user opens the extension popup.';
  }
}

export function createHandlers(router) {
  return {
    async list_tabs() {
      const tabs = await router.listTabs();
      if (!tabs.length) {
        return text(
          'No tabs are shared.\n\n' +
          (router.connectionNote() ||
            'The extension is connected but the user has not shared any tab yet. Ask them to open the tab they ' +
            'want you to see, click the Porthole icon, and choose "Share this tab". Sharing is ' +
            'per-tab and deliberate — there is no way to enumerate or access unshared tabs.'),
        );
      }
      const lines = tabs.map((t) =>
        t.error
          ? `  (error listing extension tabs: ${t.error})`
          : `  ${t.tabId}  ${t.control ? '[read+control]' : '[read-only]  '}  ${redactText(t.title || '(untitled)')}\n` +
            `        ${redactUrl(t.url || '')}${t.note ? `\n        ${t.note}` : ''}`,
      );
      const note = router.connectionNote();
      return text(
        `Shared tabs (${tabs.length}):\n${lines.join('\n')}` +
        (note ? `\n\nNote: ${note}` : '') +
        '\n\nTabs marked [read-only] reject click/type/scroll/navigate until the user enables "Allow control".',
      );
    },

    async screenshot_tab({ tabId, fullPage = false, maxWidth = 1280, format = 'jpeg' }) {
      const res = await router.call(tabId, 'screenshot_tab', {
        fullPage,
        maxWidth: Math.min(Math.max(Number(maxWidth) || 1280, 200), 2000),
        format: format === 'png' ? 'png' : 'jpeg',
      }, { timeoutMs: 45000 });
      const meta =
        `Screenshot of tab ${tabId} — ${res.width}x${res.height}px ${res.format}` +
        `${res.scaled ? ' (downscaled for context budget)' : ''}` +
        `${fullPage ? ', full page' : ', viewport only'}` +
        `${res.note ? `\n${res.note}` : ''}` +
        '\nNote: Chrome shows a "…is debugging this browser" banner on shared tabs, which can shift the page ' +
        'down a few pixels compared with what the user sees.';
      return {
        content: [
          { type: 'text', text: meta },
          { type: 'image', data: res.base64, mimeType: res.format === 'png' ? 'image/png' : 'image/jpeg' },
        ],
      };
    },

    async read_page({ tabId, mode = 'a11y', selector, maxChars }) {
      const res = await router.call(tabId, 'read_page', { mode, selector }, { timeoutMs: 30000 });
      const budget = Number(maxChars) || BUDGETS[mode] || BUDGETS.default;
      const hint =
        mode === 'a11y'
          ? `Drill into a region with read_page(tabId, {mode:'a11y', selector:'…'}) or query(tabId, selector) rather than re-reading the page.`
          : mode === 'text'
            ? `Use mode:'a11y' for a smaller, structured view, or query(tabId, selector) for a specific region.`
            : `HTML is the largest mode. Prefer mode:'a11y', or query(tabId, selector) for a specific element.`;
      const body = truncateText(redactText(res.content || ''), budget, hint);
      const header =
        `read_page(tab ${tabId}, mode=${res.mode || mode}${selector ? `, selector=${selector}` : ''})` +
        `${res.url ? `\nURL: ${redactUrl(res.url)}` : ''}${res.title ? `\nTitle: ${redactText(res.title)}` : ''}` +
        `${res.nodesDropped ? `\n${res.nodesDropped} presentational nodes collapsed.` : ''}`;
      return text(`${header}\n\n${body.text}`);
    },

    async query({ tabId, selector, limit = MAX_QUERY_MATCHES }) {
      const res = await router.call(tabId, 'query', { selector, limit: Math.min(Number(limit) || MAX_QUERY_MATCHES, 200) });
      const matches = (res.matches || []).map((m) => redactDeep(m));
      const body = renderList(matches, {
        limit: Math.min(Number(limit) || MAX_QUERY_MATCHES, 200),
        charLimit: BUDGETS.query,
        hint: 'Narrow the selector to see fewer, more relevant matches.',
        empty: `No elements match ${selector}.`,
        render: (m, i) => {
          const attrs = Object.entries(m.attributes || {})
            .map(([k, v]) => `${k}="${v}"`)
            .join(' ');
          return `[${i}] <${m.tag || '?'}${attrs ? ' ' + attrs : ''}>${m.text ? ` ${JSON.stringify(m.text)}` : ''}`;
        },
      });
      return text(`query(tab ${tabId}, ${selector}) — ${res.total ?? matches.length} match(es)\n\n${body}`);
    },

    async console_logs({ tabId, since = 0, level = 'all' }) {
      const res = await router.call(tabId, 'console_logs', { since, level });
      let entries = res.entries || [];
      if (level && level !== 'all') entries = entries.filter((e) => (e.level || 'log') === level);
      const latest = entries.reduce((max, e) => Math.max(max, e.ts || 0), since || 0);
      const body = renderList(entries, {
        limit: MAX_LOG_ENTRIES,
        charLimit: BUDGETS.console,
        hint: `Poll with console_logs(tabId, {since: ${latest}}) to see only newer entries.`,
        empty: since ? `No console entries since ${new Date(since).toISOString()}.` : 'No console entries captured.',
        render: (e) =>
          `${fmtTs(e.ts)} ${String(e.level || 'log').toUpperCase().padEnd(7)} ${redactText(e.text || '')}` +
          (e.url ? `\n         at ${redactUrl(e.url)}${e.line ? `:${e.line}` : ''}` : ''),
      });
      return text(
        `console_logs(tab ${tabId}) — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}` +
        `${res.attachedAt ? `, capturing since ${new Date(res.attachedAt).toISOString()}` : ''}\n\n${body}\n\n` +
        `Next poll: console_logs(${JSON.stringify(tabId)}, {since: ${latest}})`,
      );
    },

    async network_errors({ tabId, since = 0 }) {
      const res = await router.call(tabId, 'network_errors', { since });
      const entries = res.entries || [];
      const latest = entries.reduce((max, e) => Math.max(max, e.ts || 0), since || 0);
      const body = renderList(entries, {
        limit: MAX_LOG_ENTRIES,
        charLimit: BUDGETS.network,
        hint: `Poll with network_errors(tabId, {since: ${latest}}) for newer failures only.`,
        empty: 'No failed or non-2xx requests captured.',
        render: (e) =>
          `${fmtTs(e.ts)} ${String(e.method || 'GET').padEnd(6)} ${e.status || '---'} ${e.statusText || ''}\n` +
          `         ${redactUrl(e.url || '')}` +
          (e.failure ? `\n         ${redactText(e.failure)}` : ''),
      });
      return text(`network_errors(tab ${tabId}) — ${entries.length} failure(s)\n\n${body}`);
    },

    async click({ tabId, selector, x, y }) {
      if (!selector && (typeof x !== 'number' || typeof y !== 'number')) {
        return text('click requires either a `selector` or both `x` and `y`.');
      }
      const res = await router.call(tabId, 'click', { selector, x, y });
      return text(`Clicked ${JSON.stringify(res.clicked ?? selector ?? { x, y })} in tab ${tabId}.` +
        (res.navigated ? ' The page navigated as a result.' : ''));
    },

    async type({ tabId, selector, text: value, submit = false, clear = true }) {
      const res = await router.call(tabId, 'type', { selector, text: value, submit, clear });
      return text(
        `Typed into ${selector} in tab ${tabId} (${res.typed ?? `${String(value).length} chars`})` +
        `${submit ? ', then pressed Enter' : ''}.` +
        (res.sensitive ? ' The field is a secret field, so its value is not echoed back.' : ''),
      );
    },

    async scroll({ tabId, selector, x, y, direction }) {
      const res = await router.call(tabId, 'scroll', { selector, x, y, direction });
      return text(`Scrolled tab ${tabId} to ${JSON.stringify(res.scrolledTo ?? selector ?? direction ?? { x, y })}.`);
    },

    async wait_for({ tabId, selector, navigation = false, timeout = 10000 }) {
      if (!selector && !navigation) return text('wait_for requires either a `selector` or navigation:true.');
      const capped = Math.min(Math.max(Number(timeout) || 10000, 100), 60000);
      const res = await router.call(tabId, 'wait_for', { selector, navigation, timeout: capped }, { timeoutMs: capped + 5000 });
      if (res.matched === false) {
        return text(`wait_for timed out after ${capped}ms: ${selector ? `no element matched ${selector}` : 'no navigation occurred'}.`);
      }
      return text(
        `Condition met after ${res.waitedMs ?? '?'}ms` +
        `${selector ? ` — ${selector} is present` : ' — navigation completed'}` +
        `${res.url ? ` (now at ${redactUrl(res.url)})` : ''}.`,
      );
    },

    async navigate({ tabId, url, waitForLoad = true }) {
      const res = await router.call(tabId, 'navigate', { url, waitForLoad }, { timeoutMs: 45000 });
      return text(
        `Tab ${tabId} navigated to ${redactUrl(res.url || url)}.` +
        (res.revoked
          ? '\n\nSharing was REVOKED because this is a different origin than the one the user shared. ' +
            'Ask the user to share the tab again if you still need access.'
          : ''),
      );
    },
  };
}
