// Command implementations. One function per MCP tool; every one of them runs
// only after grants.authorize() has said yes.

import * as cdp from './cdp.js';
import * as grants from './grants.js';
import { compactAxTree } from './a11y.js';
import { isSensitiveField, redactText, redactUrl } from './redact.js';
import {
  agentCollectText, agentCollectHtml, agentQuery, agentLocate, agentExists,
  agentScroll, agentClearField,
} from './page-agent.js';

const DEFAULT_MAX_WIDTH = 1280;
const JPEG_QUALITY = 70;

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** Evaluate one of the page-agent functions inside the tab and return its value. */
async function evalInPage(tabId, fn, args = [], sessionId) {
  const expression = `(${fn.toString()})(${args.map((a) => JSON.stringify(a ?? null)).join(', ')})`;
  const res = await cdp.send(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  }, sessionId);
  if (res.exceptionDetails) {
    throw fail('internal', `page evaluation failed: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
  }
  return res.result?.value;
}

/**
 * chrome.scripting fallback, used when the debugger cannot attach — most often
 * because the user has DevTools open on that tab. Read-only: input needs CDP.
 */
async function evalViaScripting(tabId, fn, args = []) {
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: fn, args, world: 'MAIN' });
  return result;
}

async function readWithFallback(tabId, fn, args) {
  try {
    await cdp.attach(tabId);
    return await evalInPage(tabId, fn, args);
  } catch (e) {
    if (e.code !== 'devtools_conflict') throw e;
    try {
      return await evalViaScripting(tabId, fn, args);
    } catch {
      throw e; // report the original, more informative conflict error
    }
  }
}

// ------------------------------------------------------------- read-only ----

export async function list_tabs() {
  const shared = await grants.list();
  const tabs = [];
  for (const grant of shared) {
    let tab = null;
    try { tab = await chrome.tabs.get(grant.tabId); } catch { /* closed since */ }
    if (!tab) { await grants.revoke(grant.tabId, 'closed'); continue; }
    tabs.push({
      tabId: grant.tabId,
      title: tab.title,
      url: redactUrl(tab.url),
      control: grant.control,
      windowId: tab.windowId,
      active: tab.active,
      sharedAt: grant.sharedAt,
      capturing: cdp.isAttached(grant.tabId),
    });
  }
  return { tabs };
}

export async function screenshot_tab({ tabId, fullPage = false, maxWidth = DEFAULT_MAX_WIDTH, format = 'jpeg' }) {
  await cdp.attach(tabId);
  const metrics = await cdp.send(tabId, 'Page.getLayoutMetrics');
  const css = metrics.cssContentSize || metrics.contentSize;
  const viewport = metrics.cssVisualViewport || {};
  const width = fullPage ? Math.ceil(css.width) : Math.ceil(viewport.clientWidth || css.width);
  const height = fullPage ? Math.ceil(css.height) : Math.ceil(viewport.clientHeight || css.height);

  // CDP cannot resize the output, but clip.scale does the downscaling for us —
  // which is what keeps a 4K page from consuming the whole context window.
  const scale = Math.min(1, maxWidth / Math.max(width, 1));
  const params = {
    format: format === 'png' ? 'png' : 'jpeg',
    captureBeyondViewport: Boolean(fullPage),
    clip: {
      x: fullPage ? 0 : (viewport.pageX || 0),
      y: fullPage ? 0 : (viewport.pageY || 0),
      width,
      height: Math.min(height, 16384), // Chrome refuses taller captures
      scale,
    },
  };
  if (params.format === 'jpeg') params.quality = JPEG_QUALITY;

  const shot = await cdp.send(tabId, 'Page.captureScreenshot', params);
  return {
    base64: shot.data,
    format: params.format,
    width: Math.round(width * scale),
    height: Math.round(Math.min(height, 16384) * scale),
    scaled: scale < 1,
  };
}

export async function read_page({ tabId, mode = 'a11y', selector }) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);

  if (mode === 'text' || mode === 'html') {
    const fn = mode === 'text' ? agentCollectText : agentCollectHtml;
    const res = await readWithFallback(tabId, fn, [selector || null]);
    if (!res || res.error) throw fail('not_found', res?.error || 'nothing to read');
    return {
      mode,
      content: redactText(mode === 'text' ? res.text : res.html),
      title: res.title || tab?.title,
      url: res.url || tab?.url,
    };
  }

  // a11y — the default. Requires CDP; there is no scripting equivalent.
  await cdp.attach(tabId);
  const params = {};
  if (selector) {
    const doc = await cdp.send(tabId, 'DOM.getDocument', { depth: 0 });
    const node = await cdp.send(tabId, 'DOM.querySelector', { nodeId: doc.root.nodeId, selector });
    if (!node.nodeId) throw fail('not_found', `no element matches ${selector}`);
    params.nodeId = node.nodeId;
    params.fetchRelatives = false;
  }
  const tree = await cdp.send(tabId, selector ? 'Accessibility.getPartialAXTree' : 'Accessibility.getFullAXTree', params);
  const main = compactAxTree(tree.nodes || []);
  const sections = [main.text];
  let dropped = main.nodesDropped;

  // Cross-origin iframes are separate targets; read each one and label it, so
  // an embedded checkout or OAuth form is not an invisible hole in the page.
  for (const frame of cdp.getFrameSessions(tabId)) {
    try {
      const sub = await cdp.send(tabId, 'Accessibility.getFullAXTree', {}, frame.sessionId);
      const compacted = compactAxTree(sub.nodes || [], { maxNodes: 400 });
      if (compacted.text.trim()) {
        sections.push(`\n--- cross-origin iframe: ${redactUrl(frame.url)} ---\n${compacted.text}`);
        dropped += compacted.nodesDropped;
      }
    } catch { /* the frame may have gone away mid-read */ }
  }

  return {
    mode: 'a11y',
    content: sections.join('\n'),
    title: tab?.title,
    url: tab?.url,
    nodesDropped: dropped,
  };
}

export async function query({ tabId, selector, limit = 50 }) {
  const res = await readWithFallback(tabId, agentQuery, [selector, limit]);
  if (!res) throw fail('internal', 'query returned nothing');
  if (res.error) throw fail('not_found', res.error);
  // The page never sends us a password value; everything else is masked here.
  const matches = res.matches.map((m) => {
    const attrs = { ...m.attributes };
    if ('value' in attrs) {
      const descriptor = {
        type: attrs.type, name: attrs.name, id: attrs.id,
        placeholder: attrs.placeholder, autocomplete: attrs.autocomplete,
        ariaLabel: attrs['aria-label'],
      };
      attrs.value = isSensitiveField(descriptor) ? '[REDACTED]' : redactText(attrs.value);
    }
    return { ...m, text: redactText(m.text), attributes: attrs, selector };
  });
  return { matches, total: res.total };
}

export async function console_logs({ tabId, since = 0 }) {
  // Attaching is what starts capture, so a first call on a cold tab returns
  // nothing and says so rather than pretending the page is quiet.
  const wasAttached = cdp.isAttached(tabId);
  await cdp.attach(tabId);
  const { entries, attachedAt } = cdp.getConsole(tabId, since);
  return {
    entries,
    attachedAt,
    note: wasAttached ? undefined : 'Capture started with this call; earlier console output was not recorded. Reload the page to capture from the start.',
  };
}

export async function network_errors({ tabId, since = 0 }) {
  const wasAttached = cdp.isAttached(tabId);
  await cdp.attach(tabId);
  const { entries } = cdp.getNetwork(tabId, since);
  return {
    entries,
    note: wasAttached ? undefined : 'Capture started with this call; earlier requests were not recorded. Reload the page to capture from the start.',
  };
}

export async function wait_for({ tabId, selector, navigation = false, timeout = 10000 }) {
  const started = Date.now();
  const deadline = started + timeout;
  let lastUrl = (await chrome.tabs.get(tabId).catch(() => ({})))?.url;

  while (Date.now() < deadline) {
    if (navigation) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab && tab.status === 'complete' && tab.url !== lastUrl) {
        return { matched: true, waitedMs: Date.now() - started, url: tab.url };
      }
    }
    if (selector) {
      const res = await readWithFallback(tabId, agentExists, [selector]).catch(() => null);
      if (res?.found) return { matched: true, waitedMs: Date.now() - started, url: res.url };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { matched: false, waitedMs: Date.now() - started };
}

// --------------------------------------------------------------- control ----

async function locate(tabId, selector) {
  if (typeof selector === 'string' && selector.startsWith('ref=')) {
    // refs come from the a11y tree, where CSS selectors are not available.
    const backendNodeId = Number(selector.slice(4));
    const resolved = await cdp.send(tabId, 'DOM.resolveNode', { backendNodeId });
    const objectId = resolved.object?.objectId;
    if (!objectId) throw fail('not_found', `ref ${backendNodeId} no longer exists on the page`);
    const box = await cdp.send(tabId, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function () {
        this.scrollIntoView({ block: 'center', behavior: 'instant' });
        const r = this.getBoundingClientRect();
        const t = (this.getAttribute && this.getAttribute('type') || '').toLowerCase();
        return { found: true, x: r.left + r.width / 2, y: r.top + r.height / 2, tag: this.tagName.toLowerCase(), type: t, sensitive: t === 'password' };
      }`,
      returnByValue: true,
    });
    return box.result?.value;
  }
  const res = await evalInPage(tabId, agentLocate, [selector]);
  if (!res?.found) throw fail('not_found', `no element matches ${selector}`);
  return res;
}

export async function click({ tabId, selector, x, y }) {
  await cdp.attach(tabId);
  let point = { x, y };
  if (selector) {
    const el = await locate(tabId, selector);
    point = { x: el.x, y: el.y };
  }
  const urlBefore = (await chrome.tabs.get(tabId).catch(() => ({})))?.url;
  const base = { x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 };
  // Real trusted input events, so frameworks that ignore synthetic clicks still see it.
  await cdp.send(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseMoved' });
  await cdp.send(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
  await cdp.send(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
  await new Promise((r) => setTimeout(r, 150));
  const urlAfter = (await chrome.tabs.get(tabId).catch(() => ({})))?.url;
  return { clicked: selector || point, navigated: urlBefore !== urlAfter };
}

export async function type({ tabId, selector, text, submit = false, clear = true }) {
  await cdp.attach(tabId);
  const el = await locate(tabId, selector);
  await cdp.send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(el.x), y: Math.round(el.y), button: 'left', clickCount: 1 });
  await cdp.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(el.x), y: Math.round(el.y), button: 'left', clickCount: 1 });
  if (clear && !String(selector).startsWith('ref=')) {
    await evalInPage(tabId, agentClearField, [selector]).catch(() => {});
  }
  await cdp.send(tabId, 'Input.insertText', { text: String(text) });
  if (submit) {
    for (const type of ['keyDown', 'keyUp']) {
      await cdp.send(tabId, 'Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' });
    }
  }
  // The value typed into a secret field is never echoed back to the model.
  return {
    typed: el.sensitive ? '[REDACTED]' : `${String(text).length} chars`,
    sensitive: Boolean(el.sensitive),
    selector,
    submitted: submit,
  };
}

export async function scroll({ tabId, selector, x, y, direction }) {
  const res = await readWithFallback(tabId, agentScroll, [selector || null, x ?? null, y ?? null, direction || null]);
  if (res?.error) throw fail('not_found', res.error);
  return res;
}

export async function navigate({ tabId, url, waitForLoad = true }) {
  const grant = await grants.get(tabId);
  const target = new URL(url);
  await chrome.tabs.update(tabId, { url: target.toString() });

  if (waitForLoad) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab && tab.status === 'complete' && grants.originOf(tab.url) === target.origin) break;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  // Leaving the shared origin ends the share; the tab listener does this too,
  // but saying so in the response means the model is never left guessing.
  const revoked = grant && grants.originOf(url) !== grant.origin;
  return { url: target.toString(), revoked: Boolean(revoked) };
}

export const HANDLERS = {
  list_tabs, screenshot_tab, read_page, query, console_logs, network_errors,
  wait_for, click, type, scroll, navigate,
};
