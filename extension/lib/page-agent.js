// Functions that run *inside the page*, serialised and evaluated over CDP.
//
// They must be entirely self-contained — no imports, no closure variables —
// because only their source text crosses into the page. The one security rule
// they enforce locally is the important one: the value of an input[type=
// password] is never read, not even to be masked afterwards.

export function agentCollectText(selector) {
  const root = selector ? document.querySelector(selector) : document.body;
  if (!root) return { error: 'selector matched nothing' };
  const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'HEAD']);
  const out = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (skip.has(node.tagName)) return NodeFilter.FILTER_REJECT;
        const style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
          return NodeFilter.FILTER_REJECT;
        }
        if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.tagName === 'SELECT') {
          return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_SKIP;
      }
      const text = node.nodeValue.replace(/\s+/g, ' ').trim();
      return text ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const type = (node.getAttribute('type') || '').toLowerCase();
      const label = node.labels && node.labels[0] ? node.labels[0].innerText.trim() : (node.name || node.id || node.placeholder || '');
      const value = type === 'password' ? '[REDACTED]' : String(node.value ?? '').slice(0, 300);
      out.push(`[${node.tagName.toLowerCase()}${type ? ':' + type : ''}] ${label}${value ? ' = ' + value : ''}`);
    } else {
      out.push(node.nodeValue.replace(/\s+/g, ' ').trim());
    }
  }
  return {
    text: out.join('\n'),
    title: document.title,
    url: location.href,
  };
}

export function agentCollectHtml(selector) {
  const root = selector ? document.querySelector(selector) : document.documentElement;
  if (!root) return { error: 'selector matched nothing' };
  const clone = root.cloneNode(true);
  for (const el of clone.querySelectorAll('script,style,noscript,svg,link[rel=stylesheet]')) el.remove();
  // Strip password values before the markup ever leaves the page.
  for (const el of clone.querySelectorAll('input')) {
    if ((el.getAttribute('type') || '').toLowerCase() === 'password') el.setAttribute('value', '[REDACTED]');
  }
  return { html: clone.outerHTML, title: document.title, url: location.href };
}

export function agentQuery(selector, limit) {
  let nodes;
  try {
    nodes = Array.from(document.querySelectorAll(selector));
  } catch (e) {
    return { error: `invalid selector: ${e.message}` };
  }
  const total = nodes.length;
  const matches = nodes.slice(0, limit || 50).map((el) => {
    const attributes = {};
    for (const attr of el.attributes) {
      if (attr.name === 'value') continue;
      attributes[attr.name] = String(attr.value).slice(0, 300);
    }
    const type = (el.getAttribute('type') || '').toLowerCase();
    if ('value' in el && el.tagName !== 'BUTTON') {
      // Password values are never read here, so there is nothing to leak later.
      attributes.value = type === 'password' ? '[REDACTED]' : String(el.value ?? '').slice(0, 300);
    }
    const rect = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      attributes,
      visible: rect.width > 0 && rect.height > 0,
    };
  });
  return { matches, total };
}

export function agentLocate(selector) {
  const el = document.querySelector(selector);
  if (!el) return { found: false };
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const rect = el.getBoundingClientRect();
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  return {
    found: true,
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    width: rect.width,
    height: rect.height,
    tag,
    type,
    sensitive: type === 'password',
    inViewport: rect.top >= 0 && rect.bottom <= window.innerHeight,
  };
}

export function agentExists(selector) {
  try {
    return { found: Boolean(document.querySelector(selector)), readyState: document.readyState, url: location.href };
  } catch (e) {
    return { found: false, error: e.message };
  }
}

export function agentScroll(selector, x, y, direction) {
  if (selector) {
    const el = document.querySelector(selector);
    if (!el) return { error: 'selector matched nothing' };
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    return { scrolledTo: selector, scrollY: window.scrollY };
  }
  if (direction === 'top') window.scrollTo(0, 0);
  else if (direction === 'bottom') window.scrollTo(0, document.body.scrollHeight);
  else if (direction === 'up') window.scrollBy(0, -window.innerHeight * 0.9);
  else if (direction === 'down') window.scrollBy(0, window.innerHeight * 0.9);
  else window.scrollTo(x || 0, y || 0);
  return { scrolledTo: direction || { x: window.scrollX, y: window.scrollY }, scrollY: window.scrollY };
}

export function agentClearField(selector) {
  const el = document.querySelector(selector);
  if (!el) return { error: 'selector matched nothing' };
  if ('value' in el) {
    const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')?.set;
    if (setter) setter.call(el, ''); else el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return { cleared: true };
}
