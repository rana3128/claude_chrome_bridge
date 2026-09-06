// An in-memory pretend browser. It implements exactly the same command
// contract as the real extension, so the entire MCP tool surface can be
// exercised — including the permission gates and redaction — before Chrome is
// involved at all. Enabled with CCB_FAKE_TAB=1.

import { isSensitiveField, redactText, redactUrl } from '../../extension/lib/redact.js';
import { BridgeError } from './bridge.js';

// A 2x2 grey JPEG. Real enough to prove the image plumbing, small enough to ignore.
const TINY_JPEG =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAACAAIBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

const START = Date.now();

const PAGE = {
  url: 'https://example.test/account/settings?tab=security&access_token=abc123def456ghi789',
  title: 'Account settings — Example',
  fields: [
    { selector: '#email', type: 'email', name: 'email', label: 'Email', value: 'dev@example.test' },
    { selector: '#password', type: 'password', name: 'password', label: 'Password', value: 'hunter2-actual-secret' },
    { selector: '#api-key', type: 'text', name: 'apiKey', label: 'API key', value: 'sk-live-9f8e7d6c5b4a3210zyxw' },
    { selector: '#nickname', type: 'text', name: 'nickname', label: 'Display name', value: 'Vijay' },
  ],
};

export class FakeTabBackend {
  constructor() {
    this.tabId = 'fake:1';
    this.shared = true;      // the fake tab is pre-shared; it is not a real page
    this.control = false;    // ...but control still has to be granted explicitly
    this.logs = [
      { ts: START + 100, level: 'log', text: 'app booted in 412ms', url: PAGE.url, line: 1 },
      { ts: START + 900, level: 'warn', text: 'deprecated API `legacyAuth()` used', url: PAGE.url, line: 88 },
      { ts: START + 1500, level: 'error', text: 'Uncaught TypeError: user.profile is undefined', url: PAGE.url, line: 214 },
      { ts: START + 1600, level: 'info', text: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdEFGH', url: PAGE.url, line: 215 },
    ];
    this.network = [
      { ts: START + 800, method: 'GET', url: 'https://api.example.test/v1/profile', status: 500, statusText: 'Internal Server Error', type: 'xhr' },
      { ts: START + 1200, method: 'POST', url: 'https://api.example.test/v1/session?token=secret-value-here', status: 0, statusText: 'net::ERR_FAILED', type: 'fetch', failure: 'CORS: No Access-Control-Allow-Origin header' },
      { ts: START + 1400, method: 'GET', url: 'https://cdn.other.test/widget.js', status: 0, statusText: 'blocked', type: 'script', failure: 'CSP: refused to load script (script-src self)' },
    ];
  }

  #requireControl(method) {
    if (!this.control) {
      throw new BridgeError(
        'not_controllable',
        `"${method}" needs the "Allow control" toggle for this tab. Sharing a tab grants read access only; ` +
        'the user must enable control separately in the extension popup.',
      );
    }
  }

  async call(method, params = {}) {
    switch (method) {
      case 'list_tabs':
        return { tabs: [{
          tabId: this.tabId,
          title: PAGE.title,
          url: redactUrl(PAGE.url),
          control: this.control,
          windowId: 'fake',
          active: true,
          note: 'in-memory fake tab (CCB_FAKE_TAB=1)',
        }] };

      case 'screenshot_tab':
        return {
          format: params.format === 'png' ? 'png' : 'jpeg',
          base64: TINY_JPEG,
          width: 2,
          height: 2,
          scaled: true,
          note: 'fake tab: a 2x2 placeholder image',
        };

      case 'read_page':
        return { mode: params.mode || 'a11y', content: this.#render(params.mode || 'a11y') };

      case 'query': {
        const sel = String(params.selector || '');
        const matches = PAGE.fields
          .filter((f) => sel === '*' || sel === 'input' || f.selector === sel || sel.includes(f.name))
          .map((f) => ({
            selector: f.selector,
            tag: 'input',
            text: f.label,
            attributes: {
              type: f.type,
              name: f.name,
              value: isSensitiveField(f) ? '[REDACTED]' : redactText(f.value),
            },
          }));
        return { matches, total: matches.length };
      }

      case 'console_logs': {
        const since = Number(params.since) || 0;
        return { entries: this.logs.filter((e) => e.ts > since).map((e) => ({ ...e, text: redactText(e.text) })) };
      }

      case 'network_errors':
        return { entries: this.network.map((e) => ({ ...e, url: redactUrl(e.url) })) };

      case 'wait_for':
        return { matched: true, waitedMs: 0, note: 'fake tab resolves waits immediately' };

      case 'click':
        this.#requireControl('click');
        return { clicked: params.selector || `(${params.x}, ${params.y})` };

      case 'type': {
        this.#requireControl('type');
        const field = PAGE.fields.find((f) => f.selector === params.selector);
        if (field) field.value = String(params.text ?? '');
        return {
          typed: isSensitiveField(field || {}) ? '[REDACTED]' : String(params.text ?? '').length + ' chars',
          selector: params.selector,
          submitted: Boolean(params.submit),
        };
      }

      case 'scroll':
        this.#requireControl('scroll');
        return { scrolledTo: params.selector || { x: params.x ?? 0, y: params.y ?? 0 } };

      case 'navigate':
        this.#requireControl('navigate');
        PAGE.url = String(params.url);
        return { url: redactUrl(PAGE.url), note: 'fake navigation' };

      default:
        throw new BridgeError('unsupported', `fake tab does not implement "${method}"`);
    }
  }

  #render(mode) {
    if (mode === 'html') {
      const inputs = PAGE.fields
        .map((f) => `    <input id="${f.selector.slice(1)}" type="${f.type}" name="${f.name}" value="${isSensitiveField(f) ? '[REDACTED]' : redactText(f.value)}">`)
        .join('\n');
      return `<main>\n  <h1>${PAGE.title}</h1>\n  <form>\n${inputs}\n    <button type="submit">Save</button>\n  </form>\n</main>`;
    }
    if (mode === 'text') {
      return [PAGE.title, '', ...PAGE.fields.map((f) => `${f.label}: ${isSensitiveField(f) ? '[REDACTED]' : redactText(f.value)}`), '', 'Save']
        .join('\n');
    }
    // a11y (default)
    const lines = [`document "${PAGE.title}"`, '  main', `    heading "${PAGE.title}" level=1`, '    form'];
    for (const f of PAGE.fields) {
      const value = isSensitiveField(f) ? '[REDACTED]' : redactText(f.value);
      lines.push(`      textbox "${f.label}" value="${value}" #${f.selector.slice(1)}`);
    }
    lines.push('      button "Save" #save');
    return lines.join('\n');
  }
}
